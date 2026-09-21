from fastapi import APIRouter

from app.api.v1 import auth, entries, health, media, sessions, sync, tags

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(sessions.router)
api_router.include_router(entries.router)
api_router.include_router(tags.router)
api_router.include_router(media.router)
api_router.include_router(sync.router)
