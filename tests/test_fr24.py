import unittest

from livery_watch.fr24 import clean_airline, parse_board_flight, parse_history_flight, parse_live


def board_item(**times):
    return {"flight": {
        "identification": {"number": {"default": "NH7"}},
        "airline": {"name": "ANA (Pikachu Jet NH)", "code": {"iata": "nh"}},
        "aircraft": {"registration": "JA894A", "model": {"text": "Boeing 787-9"}},
        "airport": {"origin": {"code": {"iata": "NRT"}, "name": "Tokyo Narita"}},
        "time": times,
        "status": {"generic": {"status": {"text": "scheduled"}}},
    }}


class BoardFlightTest(unittest.TestCase):
    def test_prefers_actual_then_estimated_time(self):
        flight = parse_board_flight(board_item(scheduled={"arrival": 1000}, estimated={"arrival": 1300}),
                                    "arrivals", 0)
        self.assertEqual((flight["ts"], flight["schedTs"], flight["estimated"], flight["actual"]),
                         (1300, 1000, True, False))
        flight = parse_board_flight(board_item(scheduled={"arrival": 1000}, real={"arrival": 1100}), "arrivals", 0)
        self.assertEqual((flight["ts"], flight["actual"], flight["estimated"]), (1100, True, False))

    def test_fields(self):
        flight = parse_board_flight(board_item(scheduled={"arrival": 0}), "arrivals", 0)
        self.assertIsNone(flight)
        flight = parse_board_flight(board_item(scheduled={"arrival": 3600}), "arrivals", 0)
        self.assertEqual((flight["dir"], flight["airline"], flight["airlineName"], flight["other"]),
                         ("arr", "NH", "ANA", "NRT"))

    def test_skips_cancelled(self):
        item = board_item(scheduled={"arrival": 1000})
        item["flight"]["status"]["generic"]["status"]["text"] = "canceled"
        self.assertIsNone(parse_board_flight(item, "arrivals", 0))


class HistoryFlightTest(unittest.TestCase):
    def test_delayed_state_and_local_times(self):
        tz = {"offset": 3600, "abbr": "CET"}
        flight = parse_history_flight({
            "identification": {"number": {"default": "LH1"}},
            "airport": {"origin": {"code": {"iata": "FRA"}, "timezone": tz},
                        "destination": {"code": {"iata": "SFO"}, "timezone": {"offset": -25200, "abbr": "PDT"}}},
            "time": {"scheduled": {"departure": 3600, "arrival": 36000}, "estimated": {"departure": 4800}},
        })
        self.assertEqual(flight["state"], "Delayed")
        self.assertEqual(flight["dep"]["local"], "1970-01-01T02:20")
        self.assertEqual(flight["dep"]["tz"], "CET")


class LiveAndAirlineTest(unittest.TestCase):
    def test_parse_live_picks_newest_row_for_reg(self):
        old = ["a", 1, 2, 0, 0, 0, "", "", "B789", "JA894A", 100, "", "", "", 1, 0]
        new = ["a", 3, 4, 0, 5000, 170, "", "", "B789", "JA894A", 200, "", "", "", 0, 0]
        other = ["b", 5, 6, 0, 0, 0, "", "", "B738", "N1", 300, "", "", "", 1, 0]
        live = parse_live({"full_count": 3, "x": old, "y": new, "z": other}, "JA-894A")
        self.assertEqual(live, {"lat": 3, "lon": 4, "alt": 5000, "speed": 170, "onGround": False})
        self.assertIsNone(parse_live({}, "JA894A"))

    def test_clean_airline(self):
        self.assertEqual(clean_airline("Alaska Airlines (Seattle Kraken Livery)"), "Alaska Airlines")
        self.assertEqual(clean_airline("Delta Connection (SkyWest)"), "Delta Connection (SkyWest)")


if __name__ == "__main__":
    unittest.main()
