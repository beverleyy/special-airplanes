"""Parsing saved Flightradar24 responses, and noticing when their format changes."""
import copy
import json
import unittest
from pathlib import Path

from livery_watch.errors import FR24FormatError
from livery_watch.fr24 import (check_board_response, check_history_response, check_parsed_page, feed_looks_valid,
                               parse_board_flight, parse_history_flight)

FIXTURES = Path(__file__).parent / "fixtures"


def fixture(name):
    return json.loads((FIXTURES / name).read_text())


class BoardFixtureTest(unittest.TestCase):
    def setUp(self):
        self.response = fixture("fr24_airport_arrivals.json")

    def test_reads_a_real_shaped_board(self):
        plugin_data, schedule, items = check_board_response(self.response, "arrivals")
        flights = [f for f in (parse_board_flight(i, "arrivals", -25200) for i in items) if f]
        self.assertEqual(len(flights), 1)
        nh7 = flights[0]
        self.assertEqual((nh7["number"], nh7["reg"], nh7["airlineName"], nh7["liveryNote"], nh7["other"]),
                         ("NH7", "JA894A", "ANA", "Pikachu Jet NH", "NRT"))
        self.assertTrue(nh7["estimated"])
        self.assertEqual(plugin_data["details"]["timezone"]["abbr"], "PDT")

    def test_missing_plugin_data_is_a_format_change(self):
        broken = copy.deepcopy(self.response)
        broken["result"]["response"]["airport"] = {"data": {}}
        with self.assertRaises(FR24FormatError):
            check_board_response(broken, "arrivals")

    def test_rows_without_times_are_a_format_change(self):
        broken = copy.deepcopy(self.response)
        for row in broken["result"]["response"]["airport"]["pluginData"]["schedule"]["arrivals"]["data"]:
            row["flight"]["timing"] = row["flight"].pop("time")
        _, _, items = check_board_response(broken, "arrivals")
        flights = [f for f in (parse_board_flight(i, "arrivals", 0) for i in items) if f]
        with self.assertRaises(FR24FormatError):
            check_parsed_page(items, flights, "arrivals")

    def test_a_quiet_page_is_not_a_format_change(self):
        check_parsed_page([], [], "arrivals")
        _, _, items = check_board_response(self.response, "arrivals")
        check_parsed_page(items[1:], [], "arrivals")  # only a cancelled flight: well-formed, just nothing to show


class HistoryAndFeedFixtureTest(unittest.TestCase):
    def test_reads_a_real_shaped_history(self):
        rows = check_history_response(fixture("fr24_history.json"))
        flight = parse_history_flight(rows[0])
        self.assertEqual((flight["number"], flight["origin"]["code"], flight["dest"]["code"], flight["liveryNote"]),
                         ("AS1315", "SFO", "PDX", "Seattle Kraken"))
        self.assertEqual(flight["state"], "Delayed")

    def test_history_without_a_flight_list_is_a_format_change(self):
        with self.assertRaises(FR24FormatError):
            check_history_response({"result": {"response": {"data": "nope"}}})
        self.assertEqual(check_history_response({"result": {"response": {}}}), [])

    def test_feed_shape(self):
        row = ["a", 1, 2, 0, 0, 0, "", "", "B789", "JA894A", 100, "", "", "", 1, 0, "ANA7"]
        self.assertTrue(feed_looks_valid({"full_count": 1, "version": 4, "x": row}))
        self.assertFalse(feed_looks_valid({"full_count": 1, "x": {"lat": 1}}))
        self.assertFalse(feed_looks_valid("not json"))


if __name__ == "__main__":
    unittest.main()
