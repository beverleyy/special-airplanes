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


class HexCodeTest(unittest.TestCase):
    def test_parse_hex_codes(self):
        from livery_watch.aircraft_db import parse_hex_codes
        lines = ["000001;;;10;;;Miscode;", "86EF06;JA894A;B789;00;", "ACF0D8;N933AK;B39M;00;", "3C4B34;D-ABYT;B748;00;"]
        self.assertEqual(parse_hex_codes(lines, {"JA894A", "DABYT"}), {"JA894A": "86ef06", "DABYT": "3c4b34"})


class ExportTest(unittest.TestCase):
    def test_exports_entries_and_refuses_an_empty_list(self):
        import json
        import tempfile
        from pathlib import Path
        from unittest import mock

        from livery_watch import liveries
        from livery_watch.errors import LiveryWatchError
        from livery_watch.export import export_registry
        from livery_watch.liveries import LiveryImporter
        from livery_watch.store import Store

        folder = Path(tempfile.mkdtemp())
        store = Store(folder / "data.json")
        importer = LiveryImporter(store, ["https://airportwebcams.net/special-liveries/"])
        entries = [{"reg": "JA894A", "airline": "ANA", "type": "787-9", "livery": "Pikachu Jet NH"}]
        with mock.patch.object(liveries, "fetch_page", return_value=(entries, "15 September 2026")), \
             mock.patch("livery_watch.export.hex_codes", return_value={"JA894A": "86ef06"}):
            self.assertEqual(export_registry(store, importer, folder / "out.json"), 1)
        payload = json.loads((folder / "out.json").read_text())
        self.assertEqual(payload["updated"], "15 September 2026")
        self.assertEqual(payload["entries"], [{**entries[0], "hex": "86ef06"}])

        empty = Store(folder / "empty.json")
        failing = LiveryImporter(empty, ["https://airportwebcams.net/special-liveries/"])
        with mock.patch.object(liveries, "fetch_page", side_effect=LiveryWatchError("unreachable")):
            with self.assertRaises(LiveryWatchError):
                export_registry(empty, failing, folder / "nothing.json")
        self.assertFalse((folder / "nothing.json").exists())


if __name__ == "__main__":
    unittest.main()
