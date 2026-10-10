"""Pure content tests can run with standard-library unittest, without project dependencies."""

import unittest
from copy import deepcopy

from app.services.schedule_content import schedule_content_text, trim_text


def document(*nodes):
    return {"schemaVersion": 1, "doc": {"type": "doc", "content": list(nodes)}}


def text(value):
    return {"type": "text", "text": value}


def paragraph(value):
    return {"type": "paragraph", "content": [text(value)]}


class ScheduleContentTests(unittest.TestCase):
    def test_null_and_empty_body(self):
        self.assertEqual(schedule_content_text(None), "")
        self.assertEqual(schedule_content_text(document()), "")

    def test_plain_text_matches_blocks_and_hard_breaks(self):
        content = document(
            {"type": "heading", "attrs": {"level": 2}, "content": [text(" 标题 ")]},
            {"type": "paragraph", "content": [text("一"), {"type": "hardBreak"}, text("二")]},
            {"type": "bulletList", "content": [
                {"type": "listItem", "content": [paragraph("列表")]},
            ]},
            {"type": "horizontalRule"},
            {"type": "codeBlock", "content": [text("代码")]},
        )
        original = deepcopy(content)
        self.assertEqual(schedule_content_text(content), "标题\n一 二\n列表\n代码")
        self.assertEqual(content, original)

    def test_allowed_marks_are_retained_without_affecting_text(self):
        for mark in ["bold", "italic", "strike", "code"]:
            node = text("正文")
            node["marks"] = [{"type": mark}]
            self.assertEqual(schedule_content_text(document(node)), "正文")

    def test_wrong_envelope_and_schema_versions_fail(self):
        for value in [{}, [], document() | {"schemaVersion": True},
                      document() | {"schemaVersion": 2}, {"schemaVersion": 1, "doc": []}]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                schedule_content_text(value)

    def test_nested_images_and_unknown_nodes_fail(self):
        for kind in ["image", "table", "iframe", "unknown"]:
            value = document({"type": "blockquote", "content": [{"type": kind}]})
            with self.subTest(kind=kind), self.assertRaises(ValueError):
                schedule_content_text(value)

    def test_nested_doc_fails(self):
        with self.assertRaises(ValueError):
            schedule_content_text(document({"type": "doc", "content": []}))

    def test_malformed_fields_fail(self):
        for node in [None, {"type": []}, {"type": "text"}, {"type": "text", "text": 3},
                     {"type": "paragraph", "content": {}}, {"type": "paragraph", "attrs": []},
                     text("x") | {"marks": {}}, text("x") | {"marks": [{"type": "link"}]},
                     text("x") | {"marks": [{"type": []}]}]:
            with self.subTest(node=node), self.assertRaises(ValueError):
                schedule_content_text(document(node))

    def test_leaf_children_fail_instead_of_hiding_text(self):
        for node in [text("x"), {"type": "hardBreak"}, {"type": "horizontalRule"}]:
            node["content"] = [text("hidden")]
            with self.assertRaises(ValueError):
                schedule_content_text(document(node))

    def test_cycle_and_repeated_object_references_fail(self):
        node = {"type": "paragraph"}
        node["content"] = [node]
        with self.assertRaises(ValueError):
            schedule_content_text(document(node))
        node = paragraph("重复")
        with self.assertRaises(ValueError):
            schedule_content_text(document(node, node))

    def test_too_deep_tree_fails(self):
        node = text("深")
        for _ in range(101):
            node = {"type": "blockquote", "content": [node]}
        with self.assertRaises(ValueError):
            schedule_content_text(document(node))

    def test_non_json_and_non_finite_values_fail(self):
        for value in [float("nan"), float("inf"), object(), "\ud800"]:
            with self.assertRaises(ValueError):
                schedule_content_text(document() | {"extra": value})

    def test_ecmascript_whitespace_matches_frontend_trim(self):
        self.assertEqual(trim_text("\ufeff\u00a0 正文 \u3000"), "正文")
        self.assertEqual(schedule_content_text(document(paragraph("\ufeff\u3000"))), "")
        self.assertEqual(trim_text("\u001c"), "\u001c")
