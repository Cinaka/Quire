import logging
import time

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.api.v1.router import api_router
from app.core.config import settings

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(settings.APP_NAME)

app = FastAPI(title=settings.APP_NAME, docs_url="/docs", openapi_url="/openapi.json")

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.CORS_ORIGINS,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.middleware("http")
async def log_requests(request: Request, call_next):
    started = time.perf_counter()
    response = await call_next(request)
    cost = (time.perf_counter() - started) * 1000
    logger.info("%s %s -> %s %.1fms", request.method, request.url.path, response.status_code, cost)
    return response
@app.exception_handler(StarletteHTTPException)
async def http_exc_handler(_: Request, exc: StarletteHTTPException):
    return JSONResponse(
        status_code=exc.status_code,
        content={"code": exc.status_code, "message": str(exc.detail), "data": None},
    )
@app.exception_handler(RequestValidationError)
async def validation_exc_handler(_: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={"code": 422, "message": "参数校验失败", "data": exc.errors()},
    )
@app.exception_handler(Exception)
async def unhandled_exc_handler(_: Request, exc: Exception):
    logger.exception("unhandled error: %s", exc)
    return JSONResponse(
        status_code=500, content={"code": 500, "message": "服务器内部错误", "data": None}
    )
app.include_router(api_router, prefix=settings.API_V1_PREFIX)
