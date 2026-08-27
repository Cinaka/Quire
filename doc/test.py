import argparse
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import time
from contextlib import contextmanager
from hashlib import sha256
from importlib.metadata import version
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[1]
FRONTEND = ROOT / "frontend"
BACKEND = ROOT / "backend"
TOOLS = FRONTEND / "tools/fonts"
ASSETS = FRONTEND / "src/assets/fonts"
LICENSES = ASSETS / "LICENSES"

LXGW_VERSION = "v1.522"
LXGW_COMMIT = "e8b5b48b79f19f29aa68b0a178eab3472ea9f7e8"
GOOGLE_FONTS_COMMIT = "6a003b5eb672dc8bf5bff5937cf5863f8b175445"

SOURCES = {
    "LXGWWenKai-Regular.ttf": (
        f"https://raw.githubusercontent.com/lxgw/LxgwWenKai/{LXGW_COMMIT}/fonts/TTF/"
        "LXGWWenKai-Regular.ttf"
    ),
    "LXGW-WenKai-OFL.txt": (
        f"https://raw.githubusercontent.com/lxgw/LxgwWenKai/{LXGW_COMMIT}/OFL.txt"
    ),
    "MaShanZheng-Regular.ttf": (
        f"https://raw.githubusercontent.com/google/fonts/{GOOGLE_FONTS_COMMIT}/ofl/"
        "mashanzheng/MaShanZheng-Regular.ttf"
    ),
    "Ma-Shan-Zheng-OFL.txt": (
        f"https://raw.githubusercontent.com/google/fonts/{GOOGLE_FONTS_COMMIT}/ofl/"
        "mashanzheng/OFL.txt"
    ),
    "Ma-Shan-Zheng-METADATA.pb": (
        f"https://raw.githubusercontent.com/google/fonts/{GOOGLE_FONTS_COMMIT}/ofl/"
        "mashanzheng/METADATA.pb"
    ),
}

BACKEND_VERSIONS = {
    "fastapi": "0.141.1",
    "uvicorn": "0.52.3",
    "sqlalchemy": "2.0.52",
    "asyncmy": "0.2.14",
    "alembic": "1.19.1",
    "pydantic": "2.13.4",
    "pydantic-settings": "2.15.0",
    "python-jose": "3.5.0",
    "passlib": "1.7.4",
    "uuid-utils": "0.17.0",
    "redis": "8.1.0",
    "httpx": "0.28.1",
    "pytest": "9.1.1",
    "ruff": "0.16.3",
}


def run(
    *args: str,
    cwd: Path = FRONTEND,
    env: dict[str, str] | None = None,
    capture_output: bool = False,
) -> subprocess.CompletedProcess[str]:
    print("+", " ".join(args))
    return subprocess.run(
        args,
        cwd=cwd,
        env=env,
        check=True,
        text=True,
        capture_output=capture_output,
    )


def digest(path: Path) -> str:
    value = sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            value.update(chunk)
    return value.hexdigest()


def download(url: str, target: Path) -> None:
    if target.exists():
        print("= 使用已完成的缓存", target)
        return
    partial = target.with_suffix(f"{target.suffix}.part")
    run(
        "curl",
        "--fail",
        "--location",
        "--http1.1",
        "--connect-timeout",
        "30",
        "--max-time",
        "1200",
        "--retry",
        "8",
        "--retry-all-errors",
        "--continue-at",
        "-",
        "--silent",
        "--show-error",
        url,
        "--output",
        str(partial),
    )
    partial.replace(target)


@contextmanager
def source_cache():
    directory = Path(tempfile.gettempdir()) / "quire-font-source-cache"
    directory.mkdir(parents=True, exist_ok=True)
    yield str(directory)


def build_fonts() -> None:
    actual_versions = {package: version(package) for package in ("fonttools", "brotli")}
    expected_versions = {"fonttools": "4.51.0", "brotli": "1.0.9"}
    if actual_versions != expected_versions:
        raise RuntimeError(f"工具版本不匹配：{actual_versions!r} != {expected_versions!r}")

    ASSETS.mkdir(parents=True, exist_ok=True)
    LICENSES.mkdir(parents=True, exist_ok=True)
    with source_cache() as directory:
        temporary = Path(directory)
        for filename, url in SOURCES.items():
            download(url, temporary / filename)

        shutil.copyfile(temporary / "LXGW-WenKai-OFL.txt", LICENSES / "LXGW-WenKai-OFL.txt")
        shutil.copyfile(
            temporary / "Ma-Shan-Zheng-OFL.txt",
            LICENSES / "Ma-Shan-Zheng-OFL.txt",
        )

        run("node", str(TOOLS / "build_charsets.mjs"))

        kai_raw = temporary / "quire-kai-raw.woff2"
        hand_raw = temporary / "quire-hand-raw.woff2"
        run(
            "pyftsubset",
            str(temporary / "LXGWWenKai-Regular.ttf"),
            f"--text-file={TOOLS / 'kai-chars.txt'}",
            "--flavor=woff2",
            "--layout-features=*",
            f"--output-file={kai_raw}",
        )
        run(
            "python",
            str(TOOLS / "rename_font.py"),
            str(kai_raw),
            str(ASSETS / "quire-kai-subset.woff2"),
            "Quire Kai Subset",
            "QuireKaiSubset-Regular",
        )
        run(
            "pyftsubset",
            str(temporary / "MaShanZheng-Regular.ttf"),
            f"--text-file={TOOLS / 'hand-chars.txt'}",
            "--flavor=woff2",
            "--layout-features=*",
            f"--output-file={hand_raw}",
        )
        run(
            "python",
            str(TOOLS / "rename_font.py"),
            str(hand_raw),
            str(ASSETS / "quire-hand-subset.woff2"),
            "Quire Hand Subset",
            "QuireHandSubset-Regular",
        )

        print(f"LXGW WenKai {LXGW_VERSION} commit: {LXGW_COMMIT}")
        print(
            "LXGWWenKai-Regular.ttf SHA-256:",
            digest(temporary / "LXGWWenKai-Regular.ttf"),
        )
        print(f"Ma Shan Zheng google/fonts commit: {GOOGLE_FONTS_COMMIT}")
        print(
            "MaShanZheng-Regular.ttf SHA-256:",
            digest(temporary / "MaShanZheng-Regular.ttf"),
        )
        metadata = (temporary / "Ma-Shan-Zheng-METADATA.pb").read_text(encoding="utf8")
        for line in metadata.splitlines():
            if "lastModified" in line or "version:" in line:
                print("metadata", line.strip())

    run("python", str(TOOLS / "verify_fonts.py"))
    print("H 字体资产生成与验证完成")


def test_environment() -> dict[str, str]:
    env = os.environ.copy()
    env.update(
        {
            "MYSQL_PASSWORD": "test-only",
            "JWT_SECRET": "test-only-secret",
            "DATABASE_URL": (
                "mysql+asyncmy://quire:test-only@127.0.0.1:1/"
                "quire?charset=utf8mb4"
            ),
            "REDIS_ENABLED": "false",
            "DEBUG": "false",
        }
    )
    return env


def assert_backend_versions() -> None:
    actual = {package: version(package) for package in BACKEND_VERSIONS}
    if actual != BACKEND_VERSIONS:
        raise AssertionError(f"后端依赖版本不匹配：{actual!r} != {BACKEND_VERSIONS!r}")
    print("PASS 后端依赖版本与 environment.yml 一致")


def assert_gitignore() -> None:
    for relative in ("frontend/.env.development", "frontend/.env.production"):
        result = subprocess.run(
            ("git", "check-ignore", "-q", relative),
            cwd=ROOT,
            check=False,
        )
        if result.returncode != 1:
            raise AssertionError(f"{relative} 仍被 gitignore 忽略")
    result = subprocess.run(
        ("git", "check-ignore", "-q", "backend/.env"),
        cwd=ROOT,
        check=False,
    )
    if result.returncode != 0:
        raise AssertionError("backend/.env 未被 gitignore 忽略")
    print("PASS env 白名单与真实 .env 忽略规则")


def assert_static_rules() -> None:
    failures: list[str] = []
    source_files = [
        path
        for path in (FRONTEND / "src").rglob("*")
        if path.suffix in {".ts", ".vue"}
    ]
    def has_code_token(text: str, token: str) -> bool:
        comment_prefixes = ("//", "*", "#", '"""', "'''")
        return any(
            token in line and not line.lstrip().startswith(comment_prefixes)
            for line in text.splitlines()
        )

    for path in source_files:
        text = path.read_text(encoding="utf8")
        relative = path.relative_to(FRONTEND).as_posix()
        if (
            ('from "@/db/' in text or "from '@/db/" in text)
            and relative != "src/repo/index.ts"
        ):
            failures.append(f"上层直引 db: {relative}")
        if relative.startswith("src/shared/") and re.search(r"\b(?:window|document)\.", text):
            failures.append(f"shared 使用浏览器全局: {relative}")
        if has_code_token(text, "toISOString().slice"):
            failures.append(f"UTC 日期截断: {relative}")
        if "qingjian_access_token" in text:
            failures.append(f"旧 token key: {relative}")
        if 'console.log("persist")' in text or "console.log('persist')" in text:
            failures.append(f"persist 调试日志: {relative}")

    for path in (BACKEND / "app").rglob("*.py"):
        if has_code_token(path.read_text(encoding="utf8"), "datetime.now()"):
            failures.append(f"无时区 datetime.now(): {path.relative_to(BACKEND)}")

    deleted = (
        FRONTEND / "src/style.css",
        FRONTEND / "src/components/HelloWorld.vue",
        FRONTEND / "src/assets/vite.svg",
        FRONTEND / "src/assets/vue.svg",
        FRONTEND / "src/assets/hero.png",
        FRONTEND / "pnpm-lock.yaml",
        BACKEND / ".env.exampl",
    )
    for path in deleted:
        if path.exists():
            failures.append(f"应删除文件仍存在: {path.relative_to(ROOT)}")

    request_text = (FRONTEND / "src/api/request.ts").read_text(encoding="utf8")
    if request_text.count("quire_access_token") != 2:
        failures.append("request.ts 的 quire_access_token 不是恰好两处")

    main_text = (FRONTEND / "src/main.ts").read_text(encoding="utf8")
    for retained in ("purgeOrphans", "$repo", "$almanac"):
        if retained not in main_text:
            failures.append(f"main.ts 误删保留项: {retained}")
    router_text = (FRONTEND / "src/router/index.ts").read_text(encoding="utf8")
    if 'path: "/schedules"' not in router_text:
        failures.append("误删 /schedules 路由")

    expected_env = "VITE_API_BASE_URL=/api/v1\n"
    for filename in (".env.development", ".env.production"):
        if (FRONTEND / filename).read_text(encoding="utf8") != expected_env:
            failures.append(f"{filename} 不是唯一相对 API 配置")

    if failures:
        raise AssertionError("I 静态检查失败：\n- " + "\n- ".join(failures))
    print("PASS I 禁止项、删除项与必须保留项静态检查")


def uvicorn_smoke(env: dict[str, str]) -> None:
    with socket.socket() as listener:
        listener.bind(("127.0.0.1", 0))
        port = listener.getsockname()[1]

    command = (
        sys.executable,
        "-m",
        "uvicorn",
        "app.main:app",
        "--host",
        "127.0.0.1",
        "--port",
        str(port),
        "--log-level",
        "warning",
    )
    print("+", " ".join(command))
    process = subprocess.Popen(
        command,
        cwd=BACKEND,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )
    try:
        docs_url = f"http://127.0.0.1:{port}/docs"
        for _ in range(50):
            if process.poll() is not None:
                output = process.stdout.read() if process.stdout else ""
                raise RuntimeError(f"uvicorn 提前退出：\n{output}")
            try:
                with urlopen(docs_url, timeout=1) as response:
                    if response.status == 200:
                        break
            except URLError:
                time.sleep(0.1)
        else:
            raise TimeoutError("uvicorn 在 5 秒内未就绪")

        with urlopen(f"http://127.0.0.1:{port}/api/v1/health", timeout=5) as response:
            health = json.load(response)
        if health.get("status") not in {"ok", "degraded"}:
            raise AssertionError(f"health 响应异常：{health!r}")
        if not isinstance(health.get("mysql"), bool):
            raise TypeError(f"health mysql 字段异常：{health!r}")
        print(f"PASS uvicorn /docs 与 health smoke：status={health['status']}")
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)


def validate_i() -> None:
    assert_backend_versions()
    assert_gitignore()
    assert_static_rules()
    env = test_environment()

    run("npm", "run", "build", cwd=FRONTEND)
    run(
        sys.executable,
        "-m",
        "pytest",
        "tests/test_exception_handlers.py",
        "-q",
        cwd=BACKEND,
        env=env,
    )
    run(sys.executable, "-m", "ruff", "check", "app", "tests", cwd=BACKEND)
    migration = run(
        sys.executable,
        "-m",
        "alembic",
        "upgrade",
        "head",
        "--sql",
        cwd=BACKEND,
        env=env,
        capture_output=True,
    )
    if "205a34a57552" not in migration.stdout:
        raise AssertionError("Alembic 离线 SQL 未包含当前 head migration")
    print("PASS Alembic head 离线迁移编译")
    uvicorn_smoke(env)
    run("git", "diff", "--check", cwd=ROOT)
    print("I 自动验证完成")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Quire 长流程验证")
    parser.add_argument("--i", action="store_true", help="执行 I 批次综合验证")
    return parser.parse_args()


if __name__ == "__main__":
    arguments = parse_args()
    if arguments.i:
        validate_i()
    else:
        build_fonts()
