import unittest

from livery_watch.util import clean_reg, dig, local_iso, norm_reg


class UtilTest(unittest.TestCase):
    def test_norm_reg(self):
        self.assertEqual(norm_reg("ja-894a"), "JA894A")
        self.assertEqual(norm_reg(None), "")

    def test_clean_reg_accepts_registrations(self):
        for reg in ("JA894A", "G-EUPJ", "N933AK", "d-abyt"):
            self.assertTrue(clean_reg(reg), reg)

    def test_clean_reg_rejects_words(self):
        for text in ("Registration", "TBA", "Airline", "BOEING"):
            self.assertEqual(clean_reg(text), "", text)

    def test_local_iso(self):
        self.assertEqual(local_iso(3600, 9 * 3600), "1970-01-01T10:00")
        self.assertEqual(local_iso(None, 0), "")

    def test_dig(self):
        self.assertEqual(dig({"a": {"b": 1}}, "a", "b"), 1)
        self.assertIsNone(dig({"a": None}, "a", "b"))


if __name__ == "__main__":
    unittest.main()
