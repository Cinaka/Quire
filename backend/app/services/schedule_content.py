"""Pure P4 text-content validation and derivation; no DB or browser dependencies."""

import json

TEXT_NODES = {
    "doc", "paragraph", "text", "heading", "blockquote", "bulletList", "orderedList",
    "listItem", "codeBlock", "hardBreak", "horizontalRule",
}
TEXT_MARKS = {"bold", "italic", "strike", "code"}
BLOCK_NODES = {"paragraph", "heading", "blockquote", "listItem", "codeBlock"}
# Match ECMAScript String.trim, including BOM but excluding Python-only whitespace.
JS_WHITESPACE = "\u0009\u000a\u000b\u000c\u000d\u0020\u00a0\u1680\u2000\u2001\u2002" \
    "\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"


def trim_text(value: str) -> str:
    return value.strip(JS_WHITESPACE)


def schedule_content_text(content: dict | None) -> str:
    if content is None:
        return ""
    if (
        not isinstance(content, dict)
        or not isinstance(content.get("schemaVersion"), int)
        or isinstance(content["schemaVersion"], bool)
        or content["schemaVersion"] != 1
        or not isinstance(content.get("doc"), dict)
        or content["doc"].get("type") != "doc"
    ):
        raise ValueError("预简正文格式或版本不受支持")
    try:
        json.dumps(content, allow_nan=False, ensure_ascii=False).encode("utf-8")
    except (TypeError, ValueError, RecursionError) as error:
        raise ValueError("预简正文必须为有效JSON") from error
    seen: set[int] = set()
    lines: list[str] = []
    buffer: list[str] = []

    def flush() -> None:
        value = trim_text("".join(buffer))
        if value:
            lines.append(value)
        buffer.clear()

    def walk(node: object, depth: int) -> None:
        if not isinstance(node, dict) or depth > 100 or id(node) in seen:
            raise ValueError("预简正文节点无效、过深或重复引用")
        seen.add(id(node))
        kind = node.get("type")
        if not isinstance(kind, str) or kind not in TEXT_NODES:
            raise ValueError("预简首版仅支持文本节点")
        if kind == "doc" and depth != 0:
            raise ValueError("预简正文不能嵌套doc")
        if kind == "text" and not isinstance(node.get("text"), str):
            raise ValueError("预简文字节点缺少text")
        if "text" in node and not isinstance(node["text"], str):
            raise ValueError("预简文字字段无效")
        if "attrs" in node and not isinstance(node["attrs"], dict):
            raise ValueError("预简节点属性无效")
        children = node.get("content", [])
        if not isinstance(children, list):
            raise ValueError("预简正文content必须是数组")
        if kind in {"text", "hardBreak", "horizontalRule"} and children:
            raise ValueError("预简叶节点不能含子正文")
        marks = node.get("marks", [])
        if not isinstance(marks, list):
            raise ValueError("预简正文marks必须是数组")
        for mark in marks:
            if (
                not isinstance(mark, dict)
                or not isinstance(mark.get("type"), str)
                or mark["type"] not in TEXT_MARKS
            ):
                raise ValueError("预简文字标记不受支持")
        if kind == "text":
            buffer.append(node["text"])
        elif kind == "hardBreak":
            buffer.append(" ")
        else:
            for child in children:
                walk(child, depth + 1)
            if kind in BLOCK_NODES:
                flush()

    walk(content["doc"], 0)
    flush()
    return "\n".join(lines)
