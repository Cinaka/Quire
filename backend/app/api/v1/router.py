from fastapi import APIRouter

from app.api.v1 import (
    auth,
    checkins,
    entries,
    health,
    media,
    schedule_conversion,
    schedule_review,
    schedule_sync,
    schedules,
    sessions,
    sync,
    tags,
)

api_router = APIRouter()
api_router.include_router(health.router)
api_router.include_router(auth.router)
api_router.include_router(sessions.router)
api_router.include_router(entries.router)
api_router.include_router(tags.router)
api_router.include_router(media.router)
api_router.include_router(sync.router)
api_router.include_router(checkins.router)
api_router.include_router(schedule_conversion.router)
api_router.include_router(schedule_review.router)
api_router.include_router(schedule_sync.router)
api_router.include_router(schedules.router)
