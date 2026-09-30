import tempfile
import time
import unittest
from pathlib import Path

from livery_watch.errors import LiveryWatchError
from livery_watch.liveries import LiveryImporter
from livery_watch.service import LiveryWatch, common_airline_names
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

    def airport_board(self, code, mode, page, timestamp):
        self.calls.append((mode, page))
        rows, total = self.pages[mode][page - 1], len(self.pages[mode])
        return {"result": {"response": {"airport": {"pluginData": {
            "details": {"name": "Test", "timezone": {"offset": 0, "abbr": "UTC"}},
            "schedule": {mode: {"page": {"total": total}, "data": rows}},
        }}}}}


class BoardTest(unittest.TestCase):
    def make_app(self, pages):
        path = Path(tempfile.mkdtemp()) / "data.json"
        store = Store(path)
        return LiveryWatch(store, LiveryImporter(store, []), FakeClient(pages), sleep=lambda _: None)

    def test_reads_both_boards_and_stops_at_horizon(self):
        pages = {
            "arrivals": [[item("A1", "JA894A", "arrival", 600), item("A2", "", "arrival", 30 * 3600)],
                         [item("A3", "N1", "arrival", 31 * 3600)]],
            "departures": [[item("D1", "JA894A", "departure", 3600)]],
        }
        app = self.make_app(pages)
        board = app.board("sfo")
        self.assertEqual([f["number"] for f in board["flights"]], ["A1", "D1"])
        self.assertEqual(board["counts"], {"arr": 1, "dep": 1, "withTail": 2})
        self.assertFalse(board["truncated"])
        self.assertNotIn(("arrivals", 2), app.client.calls)

    def test_caches_boards(self):
        app = self.make_app({"arrivals": [[]], "departures": [[]]})
        app.board("SFO")
        app.board("SFO")
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
