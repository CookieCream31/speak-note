import uuid

from fastapi import APIRouter, HTTPException, Response, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError

from app.api.dependencies import DbSession
from app.models.tag import MeetingTag
from app.schemas.tag import MeetingTagCreate, MeetingTagRead

router = APIRouter(prefix="/tags", tags=["tags"])


@router.get("", response_model=list[MeetingTagRead])
def list_tags(session: DbSession) -> list[MeetingTag]:
    return list(session.scalars(select(MeetingTag).order_by(MeetingTag.name)))


@router.post("", response_model=MeetingTagRead, status_code=status.HTTP_201_CREATED)
def create_tag(payload: MeetingTagCreate, session: DbSession) -> MeetingTag:
    duplicate = session.scalar(
        select(MeetingTag.id).where(func.lower(MeetingTag.name) == payload.name.lower())
    )
    if duplicate is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="同じ名前のタグがあります")

    tag = MeetingTag(name=payload.name)
    session.add(tag)
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="同じ名前のタグがあります"
        ) from exc
    session.refresh(tag)
    return tag


@router.delete("/{tag_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_tag(tag_id: uuid.UUID, session: DbSession) -> Response:
    tag = session.get(MeetingTag, tag_id)
    if tag is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Tag not found")
    session.delete(tag)
    session.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
