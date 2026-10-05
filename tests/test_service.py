import tempfile
import threading
import time
import unittest
from pathlib import Path

from livery_watch.errors import LiveryWatchError
from livery_watch.liveries import LiveryImporter
from livery_watch.boards import common_airline_names
from livery_watch.service import LiveryWatch
from livery_watch.store import Store

NOW = int(time.time())


def item(number, reg, leg, offset_seconds):
    return {"flight": {
        "identification": {"number": {"default": number}},
        "aircraft": {"registration": reg},
        "time": {"scheduled": {leg: NOW + offset_seconds}},
    }}


class FakeClient:
    def __init__(self, pages):
        self.pages = pages
        self.calls = []

    def airport_board(self, code, mode, page, timestamp, details=True):
        self.calls.append((mode, page, details))
        rows, total = self.pages[mode][page - 1], len(self.pages[mode])
        return {"result": {"response": {"airport": {"pluginData": {
            "details": {"name": "Test", "timezone": {"offset": 0, "abbr": "UTC"}},
            "schedule": {mode: {"page": {"total": total}, "data": rows}},
        }}}}}


class BoardTest(unittest.TestCase):
    def make_app(self, pages):
        path = Path(tempfile.mkdtemp()) / "data.json"
        store = Store(path)
        self.cache_dir = Path(tempfile.mkdtemp()) / "cache"
        return LiveryWatch(store, LiveryImporter(store, []), FakeClient(pages), sleep=lambda _: None,
                           cache_dir=self.cache_dir)

    def test_reads_both_boards_and_stops_at_horizon(self):
        pages = {
            "arrivals": [[item("A1", "JA894A", "arrival", 600), item("A2", "", "arrival", 30 * 3600)],
                         [item("A3", "N1", "arrival", 31 * 3600)]],
            "departures": [[item("D1", "JA894A", "departure", 3600)]],
        }
        app = self.make_app(pages)
        board = app.board_complete("sfo")
        self.assertEqual([f["number"] for f in board["flights"]], ["A1", "D1"])
        self.assertEqual(board["counts"], {"arr": 1, "dep": 1, "withTail": 2})
        self.assertTrue(board["complete"])
        self.assertFalse(board["truncated"])
        self.assertNotIn(("arrivals", 2, False), app.client.calls)

    def test_asks_for_airport_details_only_on_the_first_page(self):
        pages = {"arrivals": [[item("A1", "", "arrival", 600)], [item("A2", "", "arrival", 900)]],
                 "departures": [[]]}
        app = self.make_app(pages)
        app.board_complete("SFO")
        self.assertIn(("arrivals", 1, True), app.client.calls)
        self.assertIn(("arrivals", 2, False), app.client.calls)

    def test_returns_the_first_pages_before_the_rest(self):
        release = threading.Event()
        pages = {"arrivals": [[item("A1", "", "arrival", 600)], [item("A2", "", "arrival", 900)]],
                 "departures": [[]]}
        app = self.make_app(pages)
        app._sleep = lambda _: release.wait(5)
        partial = app.board("SFO")
        self.assertFalse(partial["complete"])
        self.assertEqual([f["number"] for f in partial["flights"]], ["A1"])
        release.set()
        self.assertEqual(len(app.board_complete("SFO")["flights"]), 2)

    def test_merges_codeshare_rows_into_the_operating_flight(self):
        def codeshare(number, airline):
            row = item(number, "9V-SMF", "arrival", 600)
            row["flight"]["airline"] = {"name": airline, "code": {"iata": number[:2]}}
            row["flight"]["owner"] = {"name": "Singapore Airlines", "code": {"iata": "SQ"}}
            row["flight"]["airport"] = {"origin": {"code": {"iata": "LHR"}}}
            return row
        pages = {"arrivals": [[codeshare("LH9771", "Lufthansa"), codeshare("SQ317", "Singapore Airlines"),
                               codeshare("NZ3317", "Air New Zealand"), item("SQ1", "9V-SMG", "arrival", 600)]],
                 "departures": [[]]}
        board = self.make_app(pages).board_complete("SIN")
        self.assertEqual([f["number"] for f in board["flights"]], ["SQ317", "SQ1"])
        self.assertEqual(board["counts"]["arr"], 2)

    def test_refresh_rereads_only_the_next_few_hours(self):
        def board(numbers_and_hours):
            return [[item(n, "", "arrival", h * 3600) for n, h in page] for page in numbers_and_hours]
        pages = {"arrivals": board([[("A1", 1), ("A2", 2)], [("A3", 4), ("A4", 8)], [("A5", 20)]]),
                 "departures": [[]]}
        app = self.make_app(pages)
        first = app.board_complete("SFO")
        self.assertEqual([f["number"] for f in first["flights"]], ["A1", "A2", "A3", "A4", "A5"])
        app.client.calls.clear()
        app._jobs["SFO"].started -= 120  # past the one-minute refresh guard
        pages["arrivals"][0][0] = item("A1", "N1", "arrival", 3600)  # a tail got assigned
        refreshed = app.board_complete("SFO", fresh=True)
        self.assertEqual([c[:2] for c in app.client.calls if c[0] == "arrivals"], [("arrivals", 1), ("arrivals", 2)])
        self.assertEqual([f["number"] for f in refreshed["flights"]], ["A1", "A2", "A3", "A4", "A5"])
        self.assertEqual(refreshed["flights"][0]["reg"], "N1")

    def test_boards_survive_a_restart(self):
        pages = {"arrivals": [[item("A1", "JA894A", "arrival", 600)]], "departures": [[]]}
        app = self.make_app(pages)
        app.board_complete("SFO")
        restarted = LiveryWatch(app.store, app.importer, FakeClient(pages), sleep=lambda _: None,
                                cache_dir=self.cache_dir)
        board = restarted.board("SFO")
        self.assertEqual([f["number"] for f in board["flights"]], ["A1"])
        self.assertEqual(restarted.client.calls, [])

    def test_caches_boards(self):
        app = self.make_app({"arrivals": [[]], "departures": [[]]})
        app.board_complete("SFO")
        app.board_complete("SFO")
        self.assertEqual(len(app.client.calls), 2)

    def test_rejects_bad_codes(self):
        app = self.make_app({"arrivals": [[]], "departures": [[]]})
        with self.assertRaises(LiveryWatchError):
            app.board("SF")

    def test_tail_lookup_for_unknown_tail(self):
        app = self.make_app({"arrivals": [[]], "departures": [[]]})
        self.assertEqual(app.tail("n12345"), {"special": False, "reg": "N12345"})


class AirlineNameTest(unittest.TestCase):
    def test_most_common_name_wins(self):
        flights = [{"airline": "AK", "airlineName": "AirAsia"},
                   {"airline": "AK", "airlineName": "AirAsia"},
                   {"airline": "AK", "airlineName": "AirAsia Just coastin' in Malaysia"},
                   {"airline": "SQ", "airlineName": "Singapore Airlines"}]
        self.assertEqual(common_airline_names(flights), {"AK": "AirAsia", "SQ": "Singapore Airlines"})


if __name__ == "__main__":
    unittest.main()
