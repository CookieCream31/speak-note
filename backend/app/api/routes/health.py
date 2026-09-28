from fastapi import APIRouter
from pydantic import BaseModel
from sqlalchemy import text

from app.api.dependencies import DbSession

router = APIRouter(tags=["health"])


class HealthResponse(BaseModel):
    status: str
    database: str


@router.get("/health", response_model=HealthResponse)
def health(session: DbSession) -> HealthResponse:
    session.execute(text("SELECT 1"))
    return HealthResponse(status="ok", database="ok")
