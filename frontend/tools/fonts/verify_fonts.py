from pathlib import Path
import sys

from fontTools.ttLib import TTFont


ROOT = Path(__file__).resolve().parents[2]
CASES = (
    (
        ROOT / "tools/fonts/kai-chars.txt",
        ROOT / "src/assets/fonts/quire-kai-subset.woff2",
        "Quire Kai Subset",
        "QuireKaiSubset-Regular",
    ),
    (
        ROOT / "tools/fonts/hand-chars.txt",
        ROOT / "src/assets/fonts/quire-hand-subset.woff2",
        "Quire Hand Subset",
        "QuireHandSubset-Regular",
    ),
)
FORBIDDEN_NAMES = ("LXGW WenKai", "LXGWWenKai", "Ma Shan Zheng", "MaShanZheng")


def values_for(font: TTFont, name_id: int) -> set[str]:
    return {
        record.toUnicode()
        for record in font["name"].names
        if record.nameID == name_id
    }


for chars_path, font_path, family, postscript in CASES:
    font = TTFont(font_path)
    cmap = font.getBestCmap() or {}
    required = set(chars_path.read_text(encoding="utf8").rstrip("\r\n"))
    missing = sorted(char for char in required if ord(char) not in cmap)
    if missing:
        raise AssertionError(f"{font_path.name} cmap 缺字：{''.join(missing)}")

    expected = {
        1: family,
        4: f"{family} Regular",
        6: postscript,
        16: family,
    }
    for name_id, expected_value in expected.items():
        actual = values_for(font, name_id)
        if actual != {expected_value}:
            raise AssertionError(
                f"{font_path.name} name ID {name_id}: {sorted(actual)!r} != {expected_value!r}"
            )

    core_names = "\n".join(
        record.toUnicode()
        for record in font["name"].names
        if record.nameID in expected
    )
    leaked = [value for value in FORBIDDEN_NAMES if value.lower() in core_names.lower()]
    if leaked:
        raise AssertionError(f"{font_path.name} 核心名称仍含上游字体名：{leaked}")

    print(
        f"PASS {font_path.name}: {len(required)} chars, "
        f"{font_path.stat().st_size} bytes, family={family!r}, postscript={postscript!r}"
    )

sys.exit(0)
