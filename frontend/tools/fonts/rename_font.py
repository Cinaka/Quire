from pathlib import Path
import sys

from fontTools.ttLib import TTFont


if len(sys.argv) != 5:
    raise SystemExit("usage: rename_font.py SOURCE TARGET FAMILY POSTSCRIPT")

source = Path(sys.argv[1])
target = Path(sys.argv[2])
family = sys.argv[3]
postscript = sys.argv[4]
font = TTFont(source)
name = font["name"]
values = {
    1: family,
    2: "Regular",
    3: f"{family} Regular",
    4: f"{family} Regular",
    6: postscript,
    16: family,
    17: "Regular",
}

platforms = {(record.platformID, record.platEncID, record.langID) for record in name.names}
for record in list(name.names):
    value = values.get(record.nameID)
    if value is not None:
        name.setName(
            value,
            record.nameID,
            record.platformID,
            record.platEncID,
            record.langID,
        )

for name_id, value in values.items():
    if not any(record.nameID == name_id for record in name.names):
        for platform_id, encoding_id, language_id in platforms:
            name.setName(value, name_id, platform_id, encoding_id, language_id)

target.parent.mkdir(parents=True, exist_ok=True)
font.save(target)
