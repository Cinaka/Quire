# UUID32 改造实施记录

## 当前采用：空库切换，不迁移旧业务数据

分支：`refactor/uuid-v7-hex32`。

原先的保留数据方案已被替代：数据库业务内容已清空，但字段结构尚未修改。因此当前迁移只针对**八张业务表全部为空**的情况，直接从 `BINARY(16)` 改为 `CHAR(32) CHARACTER SET ascii COLLATE ascii_bin`，不需要中间的 VARBINARY，也不执行旧业务数据 UPDATE、DELETE 或 TRUNCATE。

**仓库修改不等于数据库已修改。** 当前没有连接或修改任何本地/服务器数据库；实际表结构只会在目标环境执行新的 Alembic revision 后改变。

## 已接入与仍待完成的范围

- 已接入：八张业务表的 18 个 UUID 字段统一使用 `UUIDHexText`；新增记录通过 ORM 绑定时写入 32 位小写 hex 文本，读取后仍为 Python UUID 对象，保留现有业务比较和 `.hex/.bytes` 接口。
- 生成：保留 UUID v7 算法；`new_id()` 仍返回 UUID 对象，新增 `new_id_hex()` 返回小写 hex32。不要通过改变 UUID 的实际身份来去掉横线。
- 已新增可执行 Alembic revision：`uuid32_empty_v1`，前置版本 `p4_convert_receipts`。历史 revision 没有改写。
- 已更新 Alembic 类型渲染及只读预览；预览调用实际冻结 revision 的规划函数，而不是旧的三阶段数据转换规划器。
- **仍未完成：** API/JWT 的全部文本输出、前端 ID 生成、媒体地址和各处校验、浏览器本地数据及备份处理的最终协调切换。当前不能宣称完整 B 方案已交付，不应部署到正式环境或重新积累正式业务数据。

内部 UUID 对象在 `str(value)` 时依然显示标准带横线形式，这是 Python 的对象表示，不代表数据库又存回了横线。当前数据库绑定明确使用 `.hex`；接口的统一文本表示属于下一步改造。

### 字段范围

| 表 | UUID 字段 |
| --- | --- |
| users | id |
| diary_entries | id、user_id、from_schedule_id |
| tags | id、user_id |
| media | id、user_id、entry_id |
| entry_tags | entry_id、tag_id |
| refresh_sessions | id、user_id |
| checkins | id、user_id |
| schedules | id、user_id、converted_entry_id |

## 空库迁移保护

升级和降级都要求：

1. 运维已停止后端、定时任务和其他写入方；本次命令显式带 `QUIRE_UUID32_EMPTY_DB_ACK=1`。确认变量不是自动停写工具，不能替代停止服务。
2. MySQL 8.0.16+、严格 SQL 模式、八张表存在且为 InnoDB。
3. **全部八张表都没有任何记录**，而不只是 users 或 diary_entries 为空。
4. 18 列类型只允许已审阅的 binary16 或 ascii/ascii_bin char32；NULL 属性必须与模型一致，额外默认值/注释/生成属性需要另行审阅。
5. 无未审阅的物理外键、触发器、UUID 前缀索引、生成列或新增二进制关联字段。元信息检查受数据库账户可见性限制，需要有足够查看权限。

所有前置检查在第一条 ALTER 前完成。每张表的 UUID 列在同一条 ALTER 中修改；主键、索引、业务 CHECK 不主动删除。迁移获取连接级命名锁以防同一迁移并发，但该锁不阻止普通应用写入。

允许**空库**在部分 ALTER 成功后重试，跳过已经完成的表；任何表一旦出现业务记录就会拒绝重试/降级。VARBINARY 等未知中间状态不会猜测处理。迁移后再检查类型和空库状态。

MySQL DDL 隐式提交，不保证事务回滚。升级前仍建议保留结构备份；不能把命令失败理解为此前 ALTER 自动撤销。不能通过清表来绕过错误提示，也不要直接把新增的 hex32 文本改回 BINARY(16)，以免截断。

## 本地操作顺序

### 1. 拉取及测试（不修改 MySQL）

先保存工作区改动，在改造分支拉取，然后从 backend 运行：

```bash
conda activate quire
python -m pytest -q tests/test_uuid_hex_storage.py tests/test_uuid_hex_models.py tests/test_uuid_empty_migration.py
```

预期为 36 项测试。这里的 SQLite 写入探针只使用临时内存数据库，不连接 `.env` 中的 MySQL。另需运行完整后端回归及 Ruff；沙箱没有代跑这些项目依赖测试。

### 2. 先检查 Alembic 版本，不要直接改表

```bash
python -m alembic current
```

原结构对应的预期版本为 `p4_convert_receipts`；执行新迁移成功后应为 `uuid32_empty_v1`。

**如果清空数据时连 `alembic_version` 也清空了，current 可能没有版本。此时先停止，不要直接 upgrade、stamp head 或重新初始化现有表。** 需要核对真实字段结构后修复正确的历史版本记录，不能用 stamp 跳过字段变更。

### 3. 只读预览（不会执行输出的 SQL）

仅在确认 `.env` 指向正确目标数据库之后：

```bash
python tools/uuid32_preflight.py --plan upgrade
```

默认 `python tools/uuid32_preflight.py` 仍只打印字段清单，不连接数据库。`--plan` 会 SELECT 元信息和行数；正常空库预览最多八条 ALTER，不包含 VARBINARY 或数据搬迁。不要手工复制预览 SQL 代替 Alembic 的版本管理。

### 4. 实际执行（待版本和测试确认后）

停止全部写入方，确认数据库版本记录正确、八张业务表为空且回归通过，才执行：

```bash
QUIRE_UUID32_EMPTY_DB_ACK=1 python -m alembic upgrade head
python -m alembic current
python tools/uuid32_preflight.py --check
```

第一条命令**会修改目标数据库字段类型**；它不是预览。环境变量仅为单次命令设置，不要长期写进 `.env` 或服务配置。成功后应看到新版本及 18 列 hex32 状态。执行前后不要启动旧后端写入。

## 浏览器及备份边界

MySQL 清空不会清空浏览器 IndexedDB、待同步队列、登录令牌或本地备份。当前没有擅自删除或迁移这些内容。若浏览器还存有旧数据，先不要启动自动同步；需确认是否也从空的浏览器数据开始，再做前端最终切换。

不应通过全局去除 JSON/正文里的横线来“迁移”；日记普通文字、URL、媒体对象及真正的关联字段不是同一回事。

## 验证记录与限制

- 沙箱：实际冻结 revision 的 28 项纯逻辑/保护测试通过；8 个模型文件、18 处 UUIDHexText 映射检查通过；Python 3.12 语法和行宽检查通过。
- 之前已通过的沙箱测试：UUID 转换 Python 12 项、前端 6 项、旧数据迁移规划器 28 项（后者已不是当前执行路径）。
- 本地此前反馈：存储适配器 5 项、前端 6 项通过。
- **本批沙箱未执行：** SQLAlchemy ORM/SQLite 新增写入测试、完整 pytest/Ruff、真正的 MySQL ALTER、完整 Alembic 链、前端类型检查/构建及端到端测试。不能把纯逻辑测试当成数据库执行成功。

新增真实 MySQL 空库演练在 `tests/test_uuid_storage_plan_mysql.py::test_empty_cutover_then_new_insert_stores_hex32`。它默认跳过；只接受 `QUIRE_TEST_UUID32_MYSQL_URL` 指向名称以 `quire_uuid32_test_` 开头、没有任何表的专用临时库，并使用 mysql+asyncmy 驱动。

该测试在临时库创建八张最小表，调用**实际冻结 revision** 执行空库升级，通过 UUIDHexText 插入/查询新 ID，检查数据库中的原始值为 hex32，验证有数据时拒绝重试/降级，再验证空库降级。测试只删除自己创建的表，不 DROP DATABASE。不得使用现有开发库或生产库；不要把含密码的 URL 发到聊天或提交版本库。测试异常中断时可能残留临时表，应人工检查。

这仍不是含全文索引和所有正式字段的完整库验收；正式结构需在真实库副本中验证。

## 历史实现

`uuid_storage_plan.py` 中的三阶段保留数据规划器及其测试保留作历史实现，不再是当前空库迁移的默认/执行路径。新 revision 完全自包含，不依赖这些可变应用模块。`UUIDBinary` 类仅供旧代码引用兼容，没有业务模型继续使用它。
