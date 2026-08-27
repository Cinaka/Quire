# Quire 字体子集

本目录保存可复现的字符表与生成/校验脚本。原始 TTF 不入仓；子集、原始 OFL 许可证、字符表和来源信息入仓。

## 官方来源与授权

两套字体均采用 SIL Open Font License 1.1。许可证原文归档在 `src/assets/fonts/LICENSES/`。

### LXGW WenKai / 霞鹜文楷 Regular

- 版本：v1.522（字体内部版本 `Version 1.522; March 17, 2026`）
- 官方仓库：https://github.com/lxgw/LxgwWenKai
- 固定 commit：`e8b5b48b79f19f29aa68b0a178eab3472ea9f7e8`
- 原始 TTF：https://raw.githubusercontent.com/lxgw/LxgwWenKai/e8b5b48b79f19f29aa68b0a178eab3472ea9f7e8/fonts/TTF/LXGWWenKai-Regular.ttf
- 原始 OFL：https://raw.githubusercontent.com/lxgw/LxgwWenKai/e8b5b48b79f19f29aa68b0a178eab3472ea9f7e8/OFL.txt
- 原始 TTF SHA-256：`39ad71264b588165b469e35e6afb162a378dacd1f95348160240ba9038ac3009`
- 子集内部名称：Family `Quire Kai Subset`；PostScript `QuireKaiSubset-Regular`

### Ma Shan Zheng / 马善政毛笔楷书

- 版本：字体内部版本 `Version 2.003`
- 官方发布源：Google Fonts 官方仓库 https://github.com/google/fonts
- 固定 commit：`6a003b5eb672dc8bf5bff5937cf5863f8b175445`
- 原始 TTF：https://raw.githubusercontent.com/google/fonts/6a003b5eb672dc8bf5bff5937cf5863f8b175445/ofl/mashanzheng/MaShanZheng-Regular.ttf
- 原始 OFL：https://raw.githubusercontent.com/google/fonts/6a003b5eb672dc8bf5bff5937cf5863f8b175445/ofl/mashanzheng/OFL.txt
- 原始 TTF SHA-256：`6d2546bb189c732a8ca29af9e22457b152387d158aa459e4ac2ce1e51788b7fb`
- 子集内部名称：Family `Quire Hand Subset`；PostScript `QuireHandSubset-Regular`

两份 OFL 的版权头部均未指定 Reserved Font Name；子集仍主动改写 name IDs 1/2/3/4/6/16/17，版权和许可证字段保持原样。

## 固定工具版本

生成环境已核对：

- `fonttools==4.51.0`
- `brotli==1.0.9`

`pyftsubset` 没有 `--version` 参数。版本查询：

```bash
python -c 'from importlib.metadata import version; print(version("fonttools"))'
python -c 'from importlib.metadata import version; print(version("brotli"))'
```

## 字符冻结

`build_charsets.mjs` 会：

1. 分别枚举 2026、2030、2034 年 1 月 1 日起 400 天的完整黄历动态字段。
2. 若仍有新增，按四年继续枚举，直到连续两个窗口无新增。
3. 合并 `src/` 中固定中文、打印 ASCII、0–9、中文与全角标点。
4. 单独将真实手写文案“今日无事，也可留白”写入 `hand-chars.txt`。

本次冻结记录：

- 2026：479 个动态字符，基线新增 479。
- 2030：476 个动态字符，新增 1（“酬”）。
- 2034：478 个动态字符，新增 1（“闰”）。
- 2038：477 个动态字符，新增 0。
- 2042：477 个动态字符，新增 0；至此连续两个窗口无新增。
- 最终 `kai-chars.txt`：1,252 个字符。
- 最终 `hand-chars.txt`：9 个字符。

每次新增使用 `--font-cn-hand` 的固定短句，必须同步加入脚本中的 `handText` 并重新生成；用户标题、正文和标签不得使用手写体。

## 复现命令

在 `frontend/` 下执行。`/path/to` 指向从上述固定 URL 下载且 SHA-256 一致的原始 TTF。

```bash
node tools/fonts/build_charsets.mjs

pyftsubset /path/to/LXGWWenKai-Regular.ttf \
  --text-file=tools/fonts/kai-chars.txt \
  --flavor=woff2 \
  --layout-features='*' \
  --output-file=/tmp/quire-kai-raw.woff2
python tools/fonts/rename_font.py \
  /tmp/quire-kai-raw.woff2 src/assets/fonts/quire-kai-subset.woff2 \
  "Quire Kai Subset" "QuireKaiSubset-Regular"

pyftsubset /path/to/MaShanZheng-Regular.ttf \
  --text-file=tools/fonts/hand-chars.txt \
  --flavor=woff2 \
  --layout-features='*' \
  --output-file=/tmp/quire-hand-raw.woff2
python tools/fonts/rename_font.py \
  /tmp/quire-hand-raw.woff2 src/assets/fonts/quire-hand-subset.woff2 \
  "Quire Hand Subset" "QuireHandSubset-Regular"

python tools/fonts/verify_fonts.py
```

从仓库根目录执行 `python doc/test.py` 可完成官方文件下载、许可证归档、字符生成、子集、内部重命名和 cmap/name table 验证。下载只写系统临时缓存，不把原始 TTF 放进仓库。

当前自动校验结果：

- `quire-kai-subset.woff2`：1,252 字，273,308 bytes。
- `quire-hand-subset.woff2`：9 字，3,464 bytes。
- 两份子集的 cmap 均完整覆盖对应字符表。
- name IDs 1/4/6/16 分别匹配 Quire Family / Full / PostScript / Typographic Family 名称。
