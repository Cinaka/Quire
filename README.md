# 青简 Quire

青简是一款以本地优先为原则的日记应用。当前 **P1** 的日记、图片、标签和设置只保存在浏览器 IndexedDB；`backend/` 中的 MySQL 五表为 **P2** 接入准备，P1 前端不会把日记同步到后端。

## 目录

- `frontend/`：Vue 3、TypeScript、Vite 前端。
- `backend/`：FastAPI、SQLAlchemy、Alembic 后端骨架。
- `doc/`：产品定案、实施清单与验证脚本。

## 前置环境

- Node.js 与 npm（前端统一使用 npm）。
- Conda 环境 `quire`，Python 3.12。
- MySQL 8.0。
- 不需要 Docker；P1 不需要 Redis，`REDIS_ENABLED=false`。

MySQL 必须使用：

- 字符集 `utf8mb4`；
- 默认时区 UTC（`default_time_zone='+00:00'`）；
- 全文索引分词 `ngram_token_size=2`。

不要把真实数据库密码、JWT 密钥或 token 写入仓库。

## Fresh clone

首次创建后端环境：

```bash
conda env create -f environment.yml
```

已有 `quire` 环境按锁定版本更新：

```bash
conda env update -f environment.yml --prune
```

## 启动后端

```bash
conda activate quire
cd backend
cp .env.example .env
```

编辑 `backend/.env`，至少替换 `MYSQL_PASSWORD` 和 `JWT_SECRET`，并确认 MySQL 用户与数据库已创建。随后执行：

```bash
python -m alembic upgrade head
python -m uvicorn app.main:app --reload --port 8000
```

验证：

- 健康检查：http://127.0.0.1:8000/api/v1/health
- OpenAPI 文档：http://127.0.0.1:8000/docs

MySQL 可连接时，健康检查应返回 `status: "ok"` 和 `mysql: true`；数据库不可用时接口仍会响应，但状态为 `degraded`。

## 启动前端

```bash
cd frontend
npm install
npm run dev
```

开发服务默认运行在 http://127.0.0.1:5173，并将 `/api` 代理到 `http://127.0.0.1:8000`。生产构建：

```bash
npm run build
```

开发与生产环境都使用相对 API 基址 `/api/v1`，仓库内 env 文件不含 host、token 或密码。

## 本地数据、备份与离线边界

P1 数据位于当前浏览器配置文件的 IndexedDB。清理站点数据、浏览器数据或更换浏览器配置文件会导致数据丢失。

请通过“设置 → 防蠹”导出备份；恢复入口也在“防蠹”中。导出的备份文件应另行妥善保存。

页面和所需资源已经加载后，本地写日记、筛选、编辑、删除、恢复与导出流程可以不依赖网络。当前没有 Service Worker，因此首次离线打开或离线强制刷新不保证可用。

## 字体授权与重建

项目使用 OFL 1.1 授权的霞鹜文楷和 Ma Shan Zheng 子集。官方来源、固定 commit、原始文件 SHA-256、许可证、字符冻结和重建命令见 [`frontend/tools/fonts/README.md`](frontend/tools/fonts/README.md)。

## 验证

前端：

```bash
cd frontend
npm run build
```

后端：

```bash
conda activate quire
cd backend
python -m pytest tests/test_exception_handlers.py -q
python -m ruff check app tests
```

仓库级 I 批次长流程统一保存在 `doc/test.py`；从根目录执行 `conda run -n quire python doc/test.py --i`。
