"""Small deterministic smoke tests for the Linux OCR engine."""
import io
import unittest
import zipfile

import app as engine


class OCRArchiveTests(unittest.TestCase):
    def test_nested_zip_imports_files_but_rejects_path_traversal(self):
        nested = io.BytesIO()
        with zipfile.ZipFile(nested, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("PHYS121/CAT.txt", "PHYS121 electricity and magnetism")
        outer = io.BytesIO()
        with zipfile.ZipFile(outer, "w", zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("../outside.txt", "must not escape")
            archive.writestr("notes.txt", "mechanical engineering notes")
            archive.writestr("nested.zip", nested.getvalue())
        budget = {"entries": 0, "unpacked": 0, "yielded": 0, "skipped": []}
        rows = list(engine.archive_entries(outer.getvalue(), "bundle.zip", budget=budget))
        names = [row[0] for row in rows]
        self.assertEqual(len(names), 2)
        self.assertFalse(any("outside.txt" in name for name in names))
        self.assertTrue(any("PHYS121/CAT.txt" in name for name in names))

    def test_plain_text_extraction_is_nonempty_and_page_bounded(self):
        pages = engine.extract_source(b"CHEM111 Organic Chemistry notes", "txt", {}, 1000)
        self.assertEqual(len(pages), 1)
        self.assertEqual(pages[0]["method"], "text-extraction")
        self.assertIn("Organic Chemistry", pages[0]["text"])

    def test_archive_guards_have_positive_defaults(self):
        self.assertGreater(engine.MAX_ARCHIVE_ENTRIES, 0)
        self.assertGreater(engine.MAX_ARCHIVE_UNPACKED_BYTES, 0)
        self.assertGreater(engine.MAX_ARCHIVE_DEPTH, 0)


if __name__ == "__main__":
    unittest.main()
