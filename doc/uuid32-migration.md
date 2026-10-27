# UUID32 改造实施记录

## 当前状态：基础模块已准备，完整改造尚未完成

分支：`refactor/uuid-v7-hex32`；起点：`8af3ea5312e408ef882477bee141437f1e4c9772`。

**本次提交不具备部署或迁移条件。** 新增适配器尚未接入现有模型、接口和客户端。现有 `new_id()` / `newId()`、`UUIDBinary`、Pydantic 模型、Dexie 数据库、备份和媒体处理逻辑均保持不变。没有新增可执行的 Alembic revision，不应因此运行数据库迁移。

目标方案：保留 UUID v7 的生成算法及每条旧记录的 128 位身份，统一业务文本为 **32 位小写十六进制**；MySQL 从 `BINARY(16)` 改为 `CHAR(32) CHARACTER SET ascii COLLATE ascii_bin`。

示例：`01a01dfa-6c0a-72a6-a7f5-76323ee01718` → `01a01dfa6c0a72a6a7f576323ee01718`。

## 本次新增

| 文件 | 用途 | 是否接入现有业务 |
| --- | --- | --- |
| `backend/app/core/uuid_hex.py` | 严格解析、无损二进制转换、旧格式兼容、重复别名检测 | 否 |
| `backend/app/db/uuid_hex.py` | 目标 CHAR(32) SQLAlchemy 类型，Python 内部保留 UUID 对象 | 否 |
| `backend/app/schemas/uuid_hex.py` | 显式 JSON 序列化类型，旧/新文本输入转 UUID，JSON 输出 hex32 | 否 |
| `frontend/src/shared/uuidHex.ts` | 前端严格规范化与重复别名检测 | 否 |
| `backend/tools/uuid32_preflight.py` | 默认仅打印字段清单；显式 `--check` 时只读检查 MySQL | 仅手动运行 |
| `backend/tools/test_uuid_hex_stdlib.py` | 无第三方依赖的后端转换测试 | 测试 |
| `backend/tests/test_uuid_hex_storage.py` | 存储适配器及 Pydantic 序列化测试 | 测试 |
| `frontend/tests/uuid-hex.test.cjs` | 执行实际 TypeScript 转换模块的边界测试 | 测试 |

注意：通用转换函数允许旧 UUID 版本；业务 UUID v7 校验需显式启用 `require_v7=True` / `requireV7=true`。文本转换不重新生成 ID，不使用 MySQL UUID 时间字段交换，不递归替换任意正文或 JSON 中的相似字符串。遇到多个旧键规范化成同一个键会拒绝，不会静默覆盖。

## 已识别的数据库范围

共 8 张表、18 个 UUID 字段：

| 表 | 字段 |
| --- | --- |
| users | id |
| diary_entries | id、user_id、from_schedule_id |
| tags | id、user_id |
| media | id、user_id、entry_id |
| entry_tags | entry_id、tag_id |
| refresh_sessions | id、user_id |
| checkins | id、user_id |
| schedules | id、user_id、converted_entry_id |

这只是已审阅模型的结构清单，不代表全部 UUID 使用位置已完成审计。JSON 内的转换回执、客户端缓存、JWT、备份及媒体地址仍需逐个处理。

## 完整切换前必须完成

- [ ] 生成与数据库：协调切换生成器输出、ORM 存储及全部主键/关联列；新增迁移，不修改已应用的历史 revision。保留唯一索引、业务约束及空值语义。
- [ ] 旧数据：迁移前备份并做实际恢复演练。按字节身份转换，逐表核对数量、关联、唯一性和转换回执。MySQL DDL 不能假设可事务回滚；迁移失败恢复流程必须单独验证。
- [ ] API 与认证：逐个接入输入校验、输出序列化及手写 JSON 字典；同步 JWT subject / session 标识、Redis 中使用 ID 的键或载荷。确定旧令牌和旧客户端兼容策略。
- [ ] 前端：接入生成器、API 参数校验、比较和本地引用，新增 Dexie 版本进行原子迁移。历史 Dexie 版本不改写；冲突不得清空或覆盖用户数据。
- [ ] 备份：更新格式及读写协议，继续识别旧版本；按已知字段迁移主键、关联、日程转换关系和草稿引用，不处理普通正文中的 UUID 外观文本。
- [ ] 媒体：明确旧文件路径兼容策略，逐个更新私有媒体校验、上传发布、URL 和 `local://media/` 引用；保留所有权校验、路径安全及禁止覆盖发布语义。
- [ ] 验收：完整后端测试、前端检查/构建、真实 MySQL 升级与恢复、旧 IndexedDB 升级、旧备份导入、登录/同步/转换/媒体端到端测试。

不要直接 `ALTER ... BINARY(16) -> CHAR(32)` 并期待 MySQL 自动生成十六进制。正确数据转换必须明确基于原始字节的 `LOWER(HEX(...))`，同时审查约束、索引、关联和失败恢复。

## 本次实际验证范围

开发沙箱 Python 3.13、Node 24：

- 无第三方依赖的后端转换测试：12 项通过。
- 前端转换模块测试：6 项通过。
- Python 文件语法解析检查及默认只读字段清单输出检查。

**未执行：** 新增 SQLAlchemy/Pydantic 测试、完整 pytest、Ruff、前端类型检查/构建、MySQL 检查或迁移、真实浏览器 IndexedDB 升级与备份/媒体端到端测试。当前沙箱缺少项目运行依赖，不能用上述 18 项基础测试代替完整验收。服务器 Python 3.12 / Node 22 上也需另行验证。

在完整仓库和依赖已安装的开发环境中，可单独运行本批测试：

```bash
cd backend
python tools/test_uuid_hex_stdlib.py
python tools/uuid32_preflight.py
python -m pytest -q tests/test_uuid_hex_storage.py
```

```bash
cd frontend
node --experimental-vm-modules --test tests/uuid-hex.test.cjs
```

### 可选只读数据库检查

仅在确认 `.env` 指向目标测试库后，从 `backend` 执行：

```bash
python tools/uuid32_preflight.py --check
```

默认命令不加载 `.env`、不连接数据库。`--check` 使用项目现有配置；建议使用只读账户。脚本不输出凭据或具体用户 ID，不执行 DDL/DML，也不会修复未匹配关联。聚合查询可能全表扫描，应在测试库或合适维护窗口使用。

预检不是完整迁移演练：它不检查全部 JSON/媒体/浏览器数据，也不证明备份可恢复。未匹配关联只做报告，须结合业务确认，不能自动删除。
