import uuid

from fastapi import APIRouter, HTTPException, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.api.dependencies import DbSession
from app.models.meeting_template import MeetingTemplate
from app.schemas.meeting_template import (
    MeetingTemplateCreate,
    MeetingTemplateRead,
    MeetingTemplateUpdate,
)

router = APIRouter(prefix="/meeting-templates", tags=["meeting-templates"])


def _set_default(session, selected: MeetingTemplate) -> None:
    defaults = session.scalars(
        select(MeetingTemplate).where(MeetingTemplate.is_default.is_(True))
    )
    for template in defaults:
        template.is_default = False
    selected.is_default = True


@router.get("", response_model=list[MeetingTemplateRead])
def list_templates(session: DbSession) -> list[MeetingTemplate]:
    return list(session.scalars(select(MeetingTemplate).order_by(MeetingTemplate.name)))


@router.get("/default", response_model=MeetingTemplateRead)
def get_default_template(session: DbSession) -> MeetingTemplate:
    template = session.scalar(select(MeetingTemplate).where(MeetingTemplate.is_default.is_(True)))
    if template is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="既定テンプレートがありません")
    return template


@router.post("", response_model=MeetingTemplateRead, status_code=status.HTTP_201_CREATED)
def create_template(payload: MeetingTemplateCreate, session: DbSession) -> MeetingTemplate:
    template = MeetingTemplate(
        name=payload.name,
        definition=payload.definition.model_dump(mode="json"),
        revision=1,
        is_default=False,
    )
    session.add(template)
    try:
        session.flush()
        if payload.is_default:
            _set_default(session, template)
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="同じ名前のテンプレートがあります") from exc
    session.refresh(template)
    return template


@router.patch("/{template_id}", response_model=MeetingTemplateRead)
def update_template(
    template_id: uuid.UUID, payload: MeetingTemplateUpdate, session: DbSession
) -> MeetingTemplate:
    template = session.get(MeetingTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="テンプレートが見つかりません")
    if payload.expected_revision is not None and payload.expected_revision != template.revision:
        raise HTTPException(status_code=409, detail="テンプレートが更新されています。再読み込みしてください")
    updates = payload.model_dump(exclude_unset=True, exclude={"expected_revision"})
    changed = False
    if "name" in updates:
        normalized_name = updates["name"].strip()
        if not normalized_name:
            raise HTTPException(status_code=422, detail="テンプレート名を入力してください")
        template.name = normalized_name
        changed = True
    if "definition" in updates:
        template.definition = payload.definition.model_dump(mode="json")
        changed = True
    if updates.get("is_default"):
        _set_default(session, template)
    elif updates.get("is_default") is False and template.is_default:
        raise HTTPException(status_code=422, detail="既定テンプレートは解除できません")
    if changed:
        template.revision += 1
    try:
        session.commit()
    except IntegrityError as exc:
        session.rollback()
        raise HTTPException(status_code=409, detail="同じ名前のテンプレートがあります") from exc
    session.refresh(template)
    return template


@router.delete("/{template_id}", status_code=status.HTTP_204_NO_CONTENT)
def delete_template(template_id: uuid.UUID, session: DbSession) -> None:
    template = session.get(MeetingTemplate, template_id)
    if template is None:
        raise HTTPException(status_code=404, detail="テンプレートが見つかりません")
    if template.is_default:
        raise HTTPException(status_code=422, detail="既定テンプレートは削除できません")
    session.delete(template)
    session.commit()



