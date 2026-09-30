import unittest

from livery_watch.liveries import merge_import, parse_page, source_id

PAGE = """
<p>Last Updated: 15-September-2026</p>
<table>
  <thead><tr><th>Airline</th><th>Registration</th><th>Aircraft Type</th><th>Special Livery</th></tr></thead>
  <tbody>
    <tr><td>ANA - Pikachu Jet NH</td><td><a href="https://www.flightradar24.com/data/aircraft/ja894a">JA894A</a></td>
        <td>Boeing 787-9</td><td>Pikachu Jet NH #New</td></tr>
    <tr><td>Airline</td><td>TBA</td><td>x</td><td>y</td></tr>
  </tbody>
</table>
<table><tr><td>JetBlue <a href="https://www.flightradar24.com/data/aircraft/n632jb">link</a></td><td>Bruins</td></tr></table>
"""


class ParsePageTest(unittest.TestCase):
    def setUp(self):
        self.entries, self.updated = parse_page(PAGE)

    def test_reads_columns_by_header(self):
        self.assertEqual(self.entries[0], {"reg": "JA894A", "airline": "ANA", "type": "Boeing 787-9",
                                           "livery": "Pikachu Jet NH"})

    def test_skips_rows_without_registrations(self):
        self.assertNotIn("TBA", [e["reg"] for e in self.entries])

    def test_reads_headerless_tables_from_links(self):
        self.assertEqual(self.entries[1]["reg"], "N632JB")

    def test_last_updated(self):
        self.assertEqual(self.updated, "15 September 2026")


class MergeImportTest(unittest.TestCase):
    def test_replaces_same_source_and_drops_legacy_entries(self):
        source = source_id("https://www.airportwebcams.net/special-liveries/")
        data = {"registry": [
            {"reg": "OLD1", "source": source},
            {"reg": "SEED1", "source": "seed"},
            {"reg": "KEEP1", "source": "import:example.com"},
        ], "imports": {}}
        merge_import(data, source, [{"reg": "NEW1", "airline": "", "type": "", "livery": "x"}], "today", "url")
        self.assertEqual(sorted(e["reg"] for e in data["registry"]), ["KEEP1", "NEW1"])
        self.assertEqual(data["imports"][source]["count"], 1)


if __name__ == "__main__":
    unittest.main()
