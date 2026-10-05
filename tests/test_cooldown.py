"""The shared pause after Flightradar24 rate limits or refuses requests."""
import io
import tempfile
import unittest
import urllib.error
from email.message import Message
from pathlib import Path
from unittest import mock

from livery_watch.cooldown import Cooldown, retry_after_seconds
from livery_watch.errors import FR24PausedError
from livery_watch.fr24 import FR24Client


class Clock:
    def __init__(self, now=1_800_000_000.0):
        self.now = now

    def __call__(self):
        return self.now


def http_error(code, retry_after=None):
    headers = Message()
    if retry_after is not None:
        headers["Retry-After"] = retry_after
    return urllib.error.HTTPError("https://api.example", code, "error", headers, io.BytesIO(b""))


class FakeResponse(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def ok():
    return FakeResponse(b'{"result": {}}')


class RetryAfterTest(unittest.TestCase):
    def test_seconds_and_dates(self):
        self.assertEqual(retry_after_seconds("30", 0), 30)
        self.assertAlmostEqual(retry_after_seconds("Thu, 01 Jan 1970 00:02:00 GMT", 60), 60)
        self.assertIsNone(retry_after_seconds("soon", 0))
        self.assertIsNone(retry_after_seconds(None, 0))


class ClientCooldownTest(unittest.TestCase):
    def setUp(self):
        self.clock = Clock()
        self.slept = []
        self.client = FR24Client(Cooldown(None, self.clock), sleep=self.slept.append, clock=self.clock)

    def run_with(self, *answers):
        replies = iter(answers)

        def urlopen(request, timeout):
            reply = next(replies)
            if isinstance(reply, Exception):
                raise reply
            return reply
        with mock.patch("urllib.request.urlopen", side_effect=urlopen) as opened:
            try:
                return self.client.get_json("https://api.example/x"), opened.call_count
            except FR24PausedError as e:
                return e, opened.call_count

    def test_a_short_retry_after_is_honoured_once(self):
        result, calls = self.run_with(http_error(429, "5"), ok())
        self.assertEqual(result, {"result": {}})
        self.assertEqual((calls, self.slept), (2, [5.0]))

    def test_a_long_rate_limit_pauses_every_request(self):
        result, _ = self.run_with(http_error(429, "120"))
        self.assertIsInstance(result, FR24PausedError)
        self.assertEqual(result.until, self.clock.now + 120)
        again, calls = self.run_with()
        self.assertIsInstance(again, FR24PausedError)
        self.assertEqual(calls, 0)
        self.clock.now += 121
        self.assertEqual(self.run_with(ok()), ({"result": {}}, 1))

    def test_rate_limits_without_retry_after_pause_a_minute(self):
        result, _ = self.run_with(http_error(429))
        self.assertEqual(result.until, self.clock.now + 60)

    def test_refusals_pause_longer_each_time_until_a_success(self):
        pauses = []
        for _ in range(4):
            result, _ = self.run_with(http_error(403))
            pauses.append(result.until - self.clock.now)
            self.clock.now = result.until
        self.assertEqual(pauses, [15 * 60, 30 * 60, 60 * 60, 60 * 60])
        self.run_with(ok())
        result, _ = self.run_with(http_error(451))
        self.assertEqual(result.until - self.clock.now, 15 * 60)

    def test_the_message_says_when_it_will_try_again(self):
        result, _ = self.run_with(http_error(403))
        self.assertIn("refusing requests", str(result))
        self.assertIn("Trying again at", str(result))


class PersistenceTest(unittest.TestCase):
    def test_a_restart_keeps_the_pause(self):
        path = Path(tempfile.mkdtemp()) / "pause.json"
        clock = Clock()
        Cooldown(path, clock).refused()
        restarted = Cooldown(path, clock)
        with self.assertRaises(FR24PausedError):
            restarted.check()
        self.assertTrue(restarted.status["paused"])


if __name__ == "__main__":
    unittest.main()
