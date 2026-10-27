# UUID32 改造实施记录

## 当前状态：基础模块及存储迁移规划已准备，完整改造尚未完成

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
| `backend/tools/uuid32_preflight.py` | 字段清单、只读检查及只读 SQL 预览；绝不执行迁移 SQL | 仅手动运行 |
| `backend/app/core/uuid_storage_plan.py` | 8 表 18 列的双向存储转换规划与前置条件校验 | 未启用 |
| `backend/app/db/uuid_storage_inspection.py` | SELECT-only MySQL 元信息适配器 | 仅手动预检调用 |
| `backend/tests/test_uuid_storage_plan.py` | 迁移规划、安全拒绝条件和同步时间戳保护测试 | 测试 |
| `backend/tests/test_uuid_storage_plan_mysql.py` | 仅供空临时库的可选 MySQL 往返演练 | 默认跳过 |
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
- 存储迁移规划测试：28 项通过（不连接 MySQL）。
- Python 3.12 语法解析、行宽检查及默认字段清单输出回归检查。
- 隔离 MySQL 测试的 8 张表建表语句和二进制样例生成检查；未执行 SQL。

**沙箱未执行：** SQLAlchemy/Pydantic 测试、完整 pytest、Ruff、前端类型检查/构建、MySQL 检查或迁移、真实浏览器 IndexedDB 升级与备份/媒体端到端测试。沙箱缺少项目运行依赖，基础测试不能代替完整验收。

本地已反馈：Python 3.12 环境的 `test_uuid_hex_storage.py` 5 项通过，前端转换测试 6 项通过；`passlib` 的 `crypt` 弃用警告不是测试失败。新增的 MySQL 存储演练仍未验证。

在完整仓库和依赖已安装的开发环境中，可单独运行本批测试：

```bash
cd backend
python tools/test_uuid_hex_stdlib.py
python tools/uuid32_preflight.py
python -m pytest -q tests/test_uuid_hex_storage.py tests/test_uuid_storage_plan.py
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


## 第二批：存储迁移规划（仍未启用）

新增规划器按三个阶段生成 SQL，而不是直接强制类型转换：

1. 每张表用一条 ALTER 同时将其全部 UUID 列扩为 `VARBINARY(32)`。
2. 每张表用一条 UPDATE 同时转换全部 UUID 列：升级用 `LOWER(HEX(...))`，降级用 `UNHEX(...)`。有 `ON UPDATE` 属性的非 UUID 列显式赋值为自身，避免历史 `updated_at` 被整库刷新、影响增量同步。NULL 保持为 NULL。
3. 每张表用一条 ALTER 同时收敛为目标格式，保留各列的 NULL/NOT NULL 语义。

日程的 `id` 与 `converted_entry_id` 必须在同条 UPDATE 中变更，不能逐列转换破坏等值约束。规划器不主动删除索引或禁用约束；实际 MySQL 对这些 ALTER 的兼容性必须通过隔离演练验证，不能仅凭渲染测试认定可用。

以下情况拒绝生成计划：非 MySQL 8.0.16+、非严格 SQL 模式、缺表或非 InnoDB、缺列、混合/中间存储状态、未审阅的 UUID 列属性、生成列、物理外键、触发器、UUID 前缀索引或新发现的二进制关联字段。元信息检查只能看到当前数据库账户有权查看的对象，不能代替管理员审计。

### 只读 SQL 预览（无需现在运行）

确认 `.env` 指向正确测试库后，可从 `backend` 执行：

```bash
python tools/uuid32_preflight.py --plan upgrade
```

此命令仅 SELECT 元信息并输出计划；输出中的 SQL **不会被执行**。`--plan` 与 `--check` 不能同时使用。只读预览不是迁移程序：它不校验全部行、不核实备份，也不应把输出直接粘贴到开发库或生产库执行。降级预览同理；真正降级必须先验证源值为小写 ASCII hex32，否则 UNHEX 可产生 NULL 或截断语义。

仍然没有新增 Alembic revision，应用继续使用原来的 `UUIDBinary`。在整个前后端切换完成前，不启用这些 SQL。

### 可选隔离 MySQL 存储演练（不是当前必做步骤）

新增测试默认跳过。只有需要验证真实 MySQL 存储转换时，才另建一个**无任何表**、名称以 `quire_uuid32_test_` 开头的专用临时数据库。测试账户需能在这个临时库建表、改表和删表。不要使用现有开发库、预发布库或生产库。

在本机安全设置 `QUIRE_TEST_UUID32_MYSQL_URL`，格式使用项目已有的 `mysql+asyncmy` 驱动；不要把含密码的 URL 发到聊天中或写入版本库。随后从 `backend` 执行：

```bash
python -m pytest -q -rs tests/test_uuid_storage_plan_mysql.py
```

测试会拒绝非临时库名及非空库，在其中创建八张最小测试表，插入固定样例，执行规划中的升级/降级 SQL，并核对 UUID 身份、NULL、同步时间戳、索引和日程 CHECK 约束。样例包括末尾零字节、旧 UUID v4、复合主键和已转换日程。

测试结束仅删除本测试成功创建的表，不执行 DROP DATABASE。强制中断或清理失败可能留下临时表，应人工检查后另建干净临时库；不要通过清空现有库来绕过保护。

这不是完整应用迁移演练：测试表不包含全部正式字段/全文索引/备份/媒体/浏览器数据，JSON 中的普通文本保持原样。真正切换仍需要完整库副本、停止写入、备份恢复验证、逐行/关联校验，以及 ORM/API/客户端/转换回执的协调升级。MySQL DDL 隐式提交，中途失败不得靠重复运行计划猜测恢复。
