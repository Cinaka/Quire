# P7 Redis 接入与验收

## 范围与状态

基线：`be5ba4190b99d8dcce565a5210e2f84163be8f07`。分支：`p7/redis-shared-rate-limits`。
用户已确认第一阶段：共享请求限流与登录失败保护；启用后故障关闭；同机 Redis/systemd；保持一个 API worker。

源码与工具端隔离回归已完成；用户已回传本地真实Redis测试、应用联调、后端回归、Ruff与前端构建通过。可以进入PR审阅；生产配置/故障/持久化验收仍有未执行项，不是合并或上线批准。
代理工具环境未安装/升级依赖、未改真实 `.env`、未连服务器、未改数据库或执行迁移。新增客户端版本声明 `redis==5.2.1`，未在代理工具环境安装或验证真实客户端连接；下方本地验证由用户执行并回传，不混为工具端实测。

不改 IndexedDB 本地优先、MySQL 日记同步/RefreshSession、媒体磁盘存储/配额/行锁/发布锁，不加入缓存、队列或分布式文件存储。Redis 共享限流不是多服务器部署批准。

## 实现

- 新增 `app/core/redis_limits.py` 与 `app/core/lua/rate_limits.lua`。FastAPI lifespan 创建和关闭异步客户端及连接池；启用时启动用真实限流 Lua 的短命专用探针核验 ACL/写入。失败则启动失败，不接受业务流量。
- 异步 facade 调用已接入中间件、登录、上传账号限流、媒体读取账号限流。禁用时调用原内存类，保留单进程测试和时钟注入接口。
- Redis 服务端 `TIME`；ZSET 精确滑动窗口，Lua 完成清理/检查/计数/TTL。每次事件 UUID，防止同毫秒去重。拒绝请求不追加同一桶的事件；此前已通过的前置桶仍计数，与原检查顺序一致。
- 所有额度沿用原值：API IP 240/min、注册 IP 5/hour、全局注册 100/滚动24h、登录 IP 30/min、上传 IP/账号各20/min、媒体读取账号120/min。
- 登录失败沿用 IP＋规范化邮箱，10次/15分钟，达到阈值后锁15分钟。并发完成的失败在锁定期间不延长锁；这点比原内存失败函数更保守地保持固定解锁时间。成功只清理其初次 check 看见的版本，不能删除随后并发登记的失败。
- 环境前缀＋HMAC-SHA256；HMAC 使用独立稳定密钥，不复用 JWT_SECRET。不存正文、图片、密码、JWT 或明文 IP/邮箱。注册全局桶也按同一规则命名。
- 活跃注册表独立限制：尝试桶最多4096、失败桶最多10000。过期成员清理，不驱逐活跃桶；达到桶容量返回429＋Retry-After=60。事件/元数据/注册表均有TTL。单桶事件数受额度约束；人为大幅提高额度会增加内存使用。
- 普通 Redis 错误、命令/总操作超时、OOM、ACL拒绝、连接池耗尽返回503，不回退内存。客户端不自动重放失败写命令；调用方收到不确定结果后重试可能多耗一次额度，这是安全优先选择。EVALSHA首次缺脚本时可加载脚本后执行，不是业务写入重放。
- 429为额度耗尽；503为安全后端不可用。均有JSON错误结构、Retry-After、private/no-store。
- `/api/v1/health` GET/HEAD 不经过应用业务限流；原健康检查HTTP 200＋status字段契约不变，Redis失败时degraded/redis=false。外部监控必须检查正文，不可只检查200。健康检查复用池，用短命独立探针验证写入；不返回连接URL/底层异常。建议在Nginx限制健康检查仅允许监控来源访问，避免无业务限流的探针被滥用。
- 只有健康路由豁免；代理头仍依赖已有受信回环 Nginx，不新增信任任意 X-Forwarded-For。

## 本机/生产配置

默认 `REDIS_ENABLED=false` 只用于本地单worker开发；公开部署显式启用。不要在运行中切换模式或混用同一服务的内存/Redis实例。

1. 用户确认并手工安装/配置 Ubuntu Redis 服务，无 Docker。查看系统实际版本和服务名，建议 Redis >=7。
2. `deploy/redis/quire.conf.example` 是待合并片段，不覆盖整个现有配置。仅绑定回环、protected-mode、独立ACL、128MiB示例上限、noeviction、AOF everysec；内存预算按服务器余量确定。不得开放公网6379。
3. `users.acl.example` 是最小命令/键空间模板；先保留独立管理账户与恢复通道，再关闭 default。真实 ACL 文件限制权限，不写入仓库。脚本内调用的命令也必须被ACL允许。客户端可尝试非必要CLIENT SETINFO，拒绝不影响其Redis 5.2.1常规连接逻辑，仍须真实验证。
4. API 的 `.env` 手工填入：

```dotenv
REDIS_ENABLED=true
REDIS_URL=redis://quire:URL_ENCODED_PASSWORD@127.0.0.1:6379/0
REDIS_KEY_PREFIX=quire:prod:rl:v1
REDIS_HMAC_SECRET=REPLACE_WITH_INDEPENDENT_RANDOM_SECRET_AT_LEAST_32_CHARS
REDIS_CONNECT_TIMEOUT=0.5
REDIS_SOCKET_TIMEOUT=0.5
REDIS_MAX_CONNECTIONS=20
REDIS_ATTEMPT_MAX_KEYS=4096
REDIS_LOGIN_MAX_KEYS=10000
```

URL中的用户名/密码需正确编码；URL和HMAC配置使用SecretStr，日志不输出完整连接异常。`.env` 仅API用户可读。所有API进程必须使用相同前缀与HMAC；换前缀/密钥会创建新计数空间，不是无损轮换。修改限额/窗口也应统一停机切换并明确额度语义，不滚动混用不同窗口。

5. 在已确认的 Conda 环境中由用户手工更新依赖（不自动安装/升级）；变更仅新增redis固定版本，不随意升级其余依赖。
6. 沿用已有systemd API模板，`--workers 1`不变；Redis用发行版 `redis-server.service`。可手工配置API `After=redis-server.service`，它只控制顺序，不保证就绪；应用启动探针才是最终门禁。不加 `Requires=` 强制联停，以便运行期返回503并在Redis恢复后自动重连。没有在本次自动启动/reload服务。

AOF everysec 不是零丢失保证；异常掉电可能丢失最近约一秒写入。正常Redis重启应恢复额度，但AOF/磁盘/配置需实际验收。noeviction避免计数被驱逐，内存满时写入报错→503；它不是防御所有DDoS的保证。Nginx原有边缘IP限流和请求体限制继续保留。

## 代理工具环境已实际执行

- Python源码语法编译与Python3.12语法解析通过（工具环境Python3.13；用户Python3.12项目环境的运行结果见下节）。
- Lua脚本通过系统liblua5.4语法编译；不等于Redis内置Lua执行通过。
- `python tools/test_p7_security_stdlib.py`：34/34，实际文件和handler/ASGI函数体，注入FastAPI/DB端口。
- `python tools/test_redis_limits_stdlib.py`：18/18，实际异步facade/中间件函数体，注入Redis/config/HTTP端口；覆盖启动全操作权限接线及失败清理、故障503、超时、容量429接线、HMAC隔离、CAS参数、取消与健康豁免。
- `node --experimental-vm-modules --test tests/security-media.test.cjs`：20/20，实际TS函数体，注入Axios/Dexie端口；含503不写本机、保留dirty、同步失败不误报成功、暂停错误仍阻止成功。

上述不冒充真实Redis原子性、FastAPI/JWT/SQLAlchemy/MySQL HTTP、Vue构建、真实IndexedDB或生产测试。

## 用户本地验收回传（代码提交 6e9b57e）

证据来源：用户在本次开发对话中提供的命令输出和联调反馈，非代理远程执行、CI日志或服务器审计；未收到完整日志文件。未提供明确验收日期，因此不补写日期。

### 环境与结果

- 用户本地 macOS / Conda quire / Python3.12；通过SSH本地端口转发访问服务器A上的Redis。此前使用的测试地址为本地127.0.0.1:16379/15，不是生产部署地址。
- 用户已单独执行Redis集成测试并反馈无报错；随后完整回归的3项跳过均明确为P4可选HTTP契约测试，没有Redis跳过项。
- 应用健康检查：`{"status":"ok","mysql":true,"redis":true}`。
- 用户反馈应用联调正常：关闭SSH隧道后请求503，重新打开后正常使用。这里只证明该断连/恢复路径，不证明Redis进程重启或AOF持久化恢复。
- 完整后端：`python -m pytest -q -rs` → **595 passed, 3 skipped, 3 warnings, 57 subtests passed in 9.53s**。前次无-rs执行也为595 passed、57 subtests passed；不把两次执行累计为更多覆盖。
- Ruff：`All checks passed!`。
- 前端安全测试：20 tests / 20 pass / 0 fail / 0 skipped。
- 前端 `npm run build`：通过，用户输出 `built in 834ms`。
- 用户回传 `git status --short` 无输出；这只说明当时本地工作区干净，不代表后续拉取或生产工作区状态。

### 3项跳过：明确未执行，不计为通过

`tests/test_schedule_resource_http_contract.py` 的3个参数场景（roundtrip、stale_image、unknown_receipt），需显式 `QUIRE_P4_HTTP_CONTRACT=1` 并使用已有前端Axios/TypeScript依赖。已核对源码：它们是P4可选真实HTTP契约回归，不是Redis测试。

本批可带此明确覆盖边界进入Redis PR审阅；不能据此宣称P4全部HTTP契约验证或整站生产验收已完成。如需单独补跑，在backend目录使用已有前端依赖执行：

```sh
QUIRE_P4_HTTP_CONTRACT=1 python -m pytest -q tests/test_schedule_resource_http_contract.py
```

### 3条警告：保留可见，不屏蔽、不顺带升级依赖

1. Passlib导入标准库crypt的弃用警告：Python3.13移除风险，应在未来运行时/密码库兼容性工作中单独验证。本批目标仍为Python3.12，不自动升级Python或替换密码哈希实现。
2. Starlette TestClient关于httpx弃用、建议httpx2的警告：测试依赖后续兼容事项，不在本批直接安装httpx2或升级FastAPI/Starlette/httpx组合。
3. SQLAlchemy identity冲突SAWarning：发生在`test_primary_key_collision_is_409_not_overwrite_or_500[entry1]`。已核对测试源码，该测试故意制造相同主键，断言409 identity_conflict、零提交且既有日记不被覆盖；该测试已通过。保留警告，不伪装成普通业务无冲突，也不为消除警告改生产事务逻辑。

结论：上述输出未显示本批Redis回归阻断失败；可进入审阅。依赖兼容性、未执行的可选契约测试和生产验收限制继续保留。

## 项目环境复现命令与尚待验收项

先检查现有未提交修改，不覆盖/reset/clean用户文件。正式测试使用独立数据与临时媒体目录。不要连接生产Redis测试。

```sh
conda activate quire
cd backend
python tools/test_p7_security_stdlib.py
python tools/test_redis_limits_stdlib.py
python -m pytest -q tests/test_rate_limit.py tests/test_p7_media_security.py tests/test_http_exception_headers.py tests/test_sync.py
python -m ruff check app tests tools/test_redis_limits_stdlib.py
```

真实Redis自动测试需已有完整项目依赖，明确提供**专用可丢弃的回环Redis DB15**。测试限定loopback及DB15，用每次随机前缀，仅清理自己的键，不执行FLUSHDB/FLUSHALL/CONFIG/SHUTDOWN。DB15不是安全隔离机制，建议使用独立Redis进程；测试账号另需SCAN/测试写入命令权限，不能把生产ACL放宽。

```sh
# 不把含密码的URL直接敲进保留历史的命令；安全地从测试环境配置导入。
export QUIRE_TEST_REDIS_URL=redis://127.0.0.1:6379/15
python -m pytest -q tests/test_redis_limits_integration.py
cd ../frontend
node --experimental-vm-modules --test tests/security-media.test.cjs
npm run build
```

集成测试覆盖：两个客户端/两个OS进程共享并发额度、TTL/窗口、活跃桶容量、登录锁定/CAS/解锁、连接池重建不清额度、真实Redis WRONGTYPE返回503、真实ASGI错误及恢复、启动ACL错误门禁。没有测试URL时真实Redis项跳过；**跳过不是通过**。启动ACL测试用注入拒绝，运行期ASGI断连用注入错误，不是实际断网。需人工完成下面故障验收。

### 人工故障与上线前门禁

仅在隔离环境执行：

- 用专用ACL启动API，确认正常注册/登录/上传与读取；先核验原有媒体鉴权、覆盖保护、账号配额回归。
- 两API进程同前缀/HMAC共享限流，重启其中一个额度不重置；这只是测试，不改变生产worker数量。
- 触发额度后正常重启专用Redis，再核对AOF恢复后的剩余额度与锁定状态；不对生产Redis执行重启实验。
- 测试期间停止专用Redis、制造短超时、使用错误密码/不足ACL、在专用实例设置低内存制造OOM：业务503，健康正文degraded，无连接密码泄露，不回退内存。恢复后业务自动恢复，不要求重启API。
- 断连发生在写入后、回执前时可能已计数，不能声称该请求确定没有消耗额度。
- 浏览器隔离账号：503时可继续本地编辑、未上传dirty保留、云端同步不得显示全部成功。若累计错误到原有3次暂停阈值，恢复后可能仍需用户手动重试/解除暂停；本批不改原同步策略。
- 检查Nginx配置、受信代理IP、HTTPS/Cookie与原P7未完成门禁；完整后端回归与前端build已有上述用户回传；真实MySQL并发、完整目标桌面/手机浏览器矩阵仍未新增证据，不能倒填通过。

## 回滚

- 不需要数据库迁移或数据回滚；Redis不存业务真相。
- 优先修复Redis/ACL/内存配置；不要把自动或临时 `REDIS_ENABLED=false` 当作公开服务的安全降级。
- 必须回退代码时，先关闭公开注册/入口或进入维护模式，停止所有API，确认只运行一个worker，再由用户选择回退到原内存版。内存版会重置安全额度，安全能力降低，需要明确接受。
- 保留AOF和现有Redis键自然TTL过期，不执行FLUSHDB。回退/重新启用前缀和HMAC应一致；不随意清理旧计数。

## PR说明与交付边界

建议PR标题：`feat(security): Redis-backed shared rate limits with fail-closed behavior`。
变更：Redis异步生命周期、Lua滑动窗口/容量保护、登录CAS清理、全调用点接线、健康脱敏、配置/依赖声明、隔离与真实集成测试、503前端回归、部署/回滚文档。
未自动创建/合并PR，未部署、未迁移。本地验证已回传，可按以下正文准备PR；合并需明确确认，生产部署另行授权。

### 可复制PR正文

#### 目的与范围

将已有防滥用状态迁至Redis共享存储，保持单worker生产部署及业务存储边界。无数据库迁移，不引入日记缓存或任务队列。

#### 变更

- FastAPI lifespan异步连接池、超时与启动写入/登录元数据/清理权限探针。
- Lua精确滑动窗口、TTL、活跃桶容量保护，覆盖注册/IP/API/上传/媒体读取。
- 登录失败锁定及成功清理CAS，避免并发失败被误清除。
- Redis启用后故障503，不自动回退内存；429与Retry-After契约保留。
- 健康检查豁免业务限流并脱敏；HMAC键空间隔离、SecretStr配置。
- Redis客户端固定版本、ACL/服务配置片段、自动测试与手工部署/回滚说明。

#### 验证

- 工具端隔离：后端原安全34/34、Redis facade18/18、前端安全20/20；Python/Lua语法检查通过。
- 用户本地回传：完整pytest595 passed、57 subtests passed、3个P4可选项skipped、3条已说明警告；Ruff通过、前端安全20/20、正式build通过。
- 真实Redis测试用户反馈通过；完整pytest仅P4可选项跳过。应用健康MySQL/Redis均true；断SSH隧道503、恢复后可用。

#### 限制与上线门禁

- 3个P4可选HTTP契约场景未执行；2个依赖弃用警告及1个预期主键冲突警告保留。
- 未新增真实MySQL并发、生产专用ACL、实际Redis重启/AOF恢复、真实OOM/密码/ACL/超时故障全矩阵或完整浏览器矩阵的验收证据。
- 不变更worker数量；同机生产后端直接连接回环Redis，不使用测试SSH隧道。
- 本PR不授权部署、数据库操作或自动合并。回滚需维护模式/关闭公开入口，不自动降级放行。
