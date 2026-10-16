# P4 图片下载真实HTTP联调指南

## 1. 本批范围：P4-4F2C12

为C10下载引擎增加可单独执行的真实传输契约测试：前端实际Axios与request.ts账号固定拦截器 → 只监听127.0.0.1随机端口的测试桥 → 实际FastAPI ASGI路由 → 实际JWT验签/临时用户查询 → 临时SQLite及媒体文件 → 前端摘要校验、单独确认和缺失槽位补齐。

这不是正式HTTP部署、浏览器跨域、刷新Cookie、MySQL锁或真实双设备验收。前端存储继续使用既有模拟事务工具，不把它称为真实IndexedDB；后端由TestClient处理，不启动uvicorn/Nginx。测试只创建进程内临时用户和短期测试JWT，不使用用户账号或凭据。

上一批5182下载面板仍等待独立浏览器反馈；“继续”不是验收通过。5179/5181/5182及日常库均不清理、不重建，不重复已完成交接。

## 2. 隔离和不变项

- `backend/tests/p4_resource_http_bridge.py`：上下文内临时监听，独立随机nonce+精确Host校验，握手后只允许指定来源的资源证明及指定媒体的原图/缩略图GET；拒绝其他路由、写方法、请求体、长路径和绝对URL。连接超时有界，退出关闭线程/端口。
- 桥只转发Authorization，不转发Cookie；不得当开发代理使用。前端固定127.0.0.1规范origin、不接受路径/凭据/外部域名，Axios禁代理和重定向。nonce不是用户登录凭据，也不替代后端鉴权。
- 测试在临时SQLite夹具内补全users字段，撤销认证替身，但保留临时数据库注入；JWT经实际security依赖解码并查询用户，随机签名密钥只在本测试monkeypatch作用域生效。
- JSON配置及JWT仅通过子进程stdin传入，不进入命令行、环境变量、页面或文件。stdout仅输出有限结果，失败只报告预定义阶段，不打印Axios错误/请求配置/token。不要粘贴原始凭据。
- 无认证/坏JWT必须401；有效但不同用户JWT必须404且无数据。正式刷新Cookie流程刻意不包含在本测试内。
- 补齐前明确选择一张媒体；prepare不写入，未确认不写入，确认后只新增缺失图片字节与一份补齐留档；来源、日记、标签、首次意图、冲突候选、owner/epoch等不变，不交接、不自动同步。
- 后端表快照及提交/flush计数必须不变。stale_image的文件变化是测试主动模拟，不是接口写入。
- 不修改应用源码、数据库schema/迁移、依赖、备份版本、正式入口或P2/P3行为；不合并main、不部署。

## 3. 本机执行

先在仓库根目录拉取当前开发分支（保留未提交改动，不重置分支）：

```bash
git status
git pull --ff-only
```

使用现有后端环境和前端已安装的项目依赖；不需要真实账号、不启动日常开发服务、不运行alembic或清库命令。Node使用项目支持版本，前端须已有Axios、TypeScript。缺依赖时先核对现有安装，不为本测试升级依赖。

在`backend`目录：

```bash
python -m ruff check tests/p4_resource_http_bridge.py tests/test_schedule_resource_http_bridge_state.py tests/test_schedule_resource_http_contract.py
python -m pytest -q tests/test_schedule_resource_http_bridge_state.py
QUIRE_P4_HTTP_CONTRACT=1 python -m pytest -q tests/test_schedule_resource_http_contract.py
```

最后一条显式开启真实Axios/ASGI/JWT联调，预期3项：

1. `roundtrip`：原图+缩略图摘要、大小、MIME均一致，prepare及取消确认不写，最终一次明确补齐后字节与留档存在、保护不变，重复票据拒绝。
2. `stale_image`：证明取得后服务端文件变化，下载409/no-store且无图片数据；整个准备失败，不写任何本机字节或留档。
3. `unknown_receipt`：未知回执保持保护，不开始图片下载，不写本机数据。

三种场景均实际检查401/404身份隔离。SQLite/文件/监听端口由测试作用域处理，无需手动删库或复制文件。

默认`python -m pytest -q`不会执行这3项Axios/JWT联调或启动其Node子进程：它们明确显示skip，不算已通过。另一个标准库桥测试仍会短暂监听127.0.0.1随机端口。环境变量只控制测试，不是任何应用功能开关。

在`frontend`目录可先单独检查脚本守卫：

```bash
node --test tests/schedules-resource-http-contract.test.cjs
```

该29项包含26项配置/静态守卫与3项**模拟fetch/Axios**的脚本接线检查，不能代替上面真实联调3项。`npm run check:p4`会自动发现这些普通测试，并继续包含build，不自动运行后端/真实HTTP测试。正式全量回归需要时再执行后端全量与check:p4/P3，不把新增测试通过当成全量已过。

## 4. 失败处理

- `startup`：检查Node版本、前端现有依赖和脚本能否启动；不输出stdin/token。
- `configuration`/`handshake`：检查测试桥地址/nonce与本机回环监听限制；不要改成真实服务URL或放宽外部地址。
- `backend-authentication`：检查实际JWT、用户模型与临时表，不恢复`get_current_user`假身份以绕过失败。
- `frontend-transport`：检查现有Axios/TypeScript是否可由frontend解析。
- `resource-proof`：检查前后端信封、字段、时间精度及回执；不可删掉校验来过测试。
- `download-prepare`/`confirmed-transaction`/`persisted-bytes-and-protection`：检查预期拒绝或两阶段补齐、字节摘要、留档与保护不变项；不要清除真实数据排障。

可提供失败测试名和上述安全阶段，但不要提供JWT、Cookie、个人日记、完整Axios配置或私有图片。若本机禁止监听回环端口，应记录环境限制，不外推为应用故障或验收通过。

## 5. 本批实际结果与后续

本批沙箱实际通过：Python标准库真实回环桥7项（下游为假ASGI客户端），前端新增29项守卫/模拟接线；与原下载引擎和图片请求相关回归组合结果另见真相来源。Python语法及100字符行宽检查通过，不是Ruff。

沙箱缺FastAPI/SQLAlchemy/pytest/Ruff及真实Axios，真实JWT/ASGI联调3项**未执行**。不声称Ruff、vue-tsc/Vite、完整P4/P3、本机浏览器或双设备通过。

下一步取得真实HTTP联调日志和5182浏览器反馈，再决定受控真实浏览器/账号联调及剩余差异处理；不自动开放正式入口。不同图片字节/共享标签差异、删除不一致/purged、未知回执处置、永久弃去、完整同步与真实双设备仍未完成。
