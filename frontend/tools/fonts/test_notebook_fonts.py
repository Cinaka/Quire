import importlib.util
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("notebook_fonts", Path(__file__).with_name("build_notebook_fonts.py"))
fonts = importlib.util.module_from_spec(spec)
spec.loader.exec_module(fonts)


class NotebookFontPlanTests(unittest.TestCase):
    def test_public_ranges_exclude_private_text_and_emoji(self):
        points = fonts.public_codepoints()
        self.assertIn(ord("青"), points)
        self.assertNotIn(0x1F600, points)
        self.assertNotIn(0x20000, points)

    def test_disjoint_256_codepoint_buckets_and_cmap_intersection(self):
        plan = fonts.groups([0x20, 0x21, 0x4E00, 0x4EFF, 0x4F00, 0x1F600])
        self.assertEqual(plan, {0: [0x20, 0x21], 0x4E: [0x4E00, 0x4EFF], 0x4F: [0x4F00]})

    def test_ranges_are_exact_not_broad_declarations(self):
        self.assertEqual(fonts.unicode_ranges([0x4E00, 0x4E01, 0x4E03]), "U+4E00-4E01, U+4E03")
        self.assertEqual(fonts.unicode_ranges([]), "")

    def test_tool_mismatch_fails_before_any_output(self):
        with patch.object(fonts, "version", return_value="wrong"):
            with self.assertRaisesRegex(RuntimeError, "未自动安装"):
                fonts.preflight(Path("not-present.ttf"))

    def test_wrong_source_hash_fails_before_font_loading(self):
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "wrong.ttf"
            source.write_bytes(b"not-a-font")
            with patch.object(fonts, "version", side_effect=lambda key: fonts.EXPECTED_TOOLS[key]):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    fonts.preflight(source)


if __name__ == "__main__":
    unittest.main()
