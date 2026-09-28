import uuid

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import select

from app.api.dependencies import DbSession
from app.models.knowledge import PersonalProfile, Project, ProjectDocument

router = APIRouter(prefix="/knowledge", tags=["knowledge"])


class KnowledgeWrite(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)


class ProfileWrite(KnowledgeWrite):
    name: str = Field(min_length=1, max_length=100)
    body: str = Field(default="", max_length=30000)


class ProfileRead(ProfileWrite):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    revision: int


class ProjectWrite(KnowledgeWrite):
    name: str = Field(min_length=1, max_length=100)
    notes: str = Field(default="", max_length=30000)
    parent_id: uuid.UUID | None = None
    profile_id: uuid.UUID | None = None


class ProjectRead(ProjectWrite):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    revision: int


class DocumentWrite(KnowledgeWrite):
    name: str = Field(min_length=1, max_length=200)
    content: str = Field(min_length=1, max_length=100000)
    included: bool = True


class DocumentRead(DocumentWrite):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    project_id: uuid.UUID
    revision: int


def _project(session: DbSession, project_id: uuid.UUID) -> Project:
    project = session.get(Project, project_id)
    if project is None:
        raise HTTPException(404, "プロジェクトが見つかりません")
    return project


def _validate_project(
    session: DbSession, payload: ProjectWrite, *, current_id: uuid.UUID | None = None
) -> None:
    if payload.parent_id is not None:
        parent = _project(session, payload.parent_id)
        if parent.parent_id is not None or parent.id == current_id:
            raise HTTPException(422, "階層は親プロジェクトと子プロジェクトの2階層までです")
    if payload.profile_id is not None and session.get(PersonalProfile, payload.profile_id) is None:
        raise HTTPException(404, "プロフィールが見つかりません")
    if current_id is not None and payload.parent_id is not None:
        child = session.scalar(select(Project.id).where(Project.parent_id == current_id).limit(1))
        if child is not None:
            raise HTTPException(422, "子プロジェクトのあるプロジェクトは子に移動できません")


@router.get("/profiles", response_model=list[ProfileRead])
def list_profiles(session: DbSession) -> list[PersonalProfile]:
    return list(session.scalars(select(PersonalProfile).order_by(PersonalProfile.created_at)))


@router.post("/profiles", response_model=ProfileRead, status_code=201)
def create_profile(payload: ProfileWrite, session: DbSession) -> PersonalProfile:
    profile = PersonalProfile(**payload.model_dump())
    session.add(profile)
    session.commit()
    session.refresh(profile)
    return profile


@router.put("/profiles/{profile_id}", response_model=ProfileRead)
def update_profile(
    profile_id: uuid.UUID, payload: ProfileWrite, session: DbSession
) -> PersonalProfile:
    profile = session.get(PersonalProfile, profile_id)
    if profile is None:
        raise HTTPException(404, "プロフィールが見つかりません")
    for field, value in payload.model_dump().items():
        setattr(profile, field, value)
    profile.revision += 1
    session.commit()
    session.refresh(profile)
    return profile


@router.get("/projects", response_model=list[ProjectRead])
def list_projects(session: DbSession) -> list[Project]:
    return list(session.scalars(select(Project).order_by(Project.created_at, Project.id)))


@router.post("/projects", response_model=ProjectRead, status_code=201)
def create_project(payload: ProjectWrite, session: DbSession) -> Project:
    _validate_project(session, payload)
    project = Project(**payload.model_dump())
    session.add(project)
    session.commit()
    session.refresh(project)
    return project


@router.put("/projects/{project_id}", response_model=ProjectRead)
def update_project(project_id: uuid.UUID, payload: ProjectWrite, session: DbSession) -> Project:
    project = _project(session, project_id)
    _validate_project(session, payload, current_id=project.id)
    for field, value in payload.model_dump().items():
        setattr(project, field, value)
    project.revision += 1
    session.commit()
    session.refresh(project)
    return project


@router.get("/projects/{project_id}/documents", response_model=list[DocumentRead])
def list_documents(project_id: uuid.UUID, session: DbSession) -> list[ProjectDocument]:
    _project(session, project_id)
    return list(session.scalars(
        select(ProjectDocument).where(ProjectDocument.project_id == project_id)
        .order_by(ProjectDocument.created_at, ProjectDocument.id)
    ))


@router.post("/projects/{project_id}/documents", response_model=DocumentRead, status_code=201)
def create_document(
    project_id: uuid.UUID, payload: DocumentWrite, session: DbSession
) -> ProjectDocument:
    _project(session, project_id)
    document = ProjectDocument(project_id=project_id, **payload.model_dump())
    session.add(document)
    session.commit()
    session.refresh(document)
    return document


@router.put("/projects/{project_id}/documents/{document_id}", response_model=DocumentRead)
def update_document(
    project_id: uuid.UUID, document_id: uuid.UUID, payload: DocumentWrite,
    session: DbSession,
) -> ProjectDocument:
    document = session.get(ProjectDocument, document_id)
    if document is None or document.project_id != project_id:
        raise HTTPException(404, "資料が見つかりません")
    for field, value in payload.model_dump().items():
        setattr(document, field, value)
    document.revision += 1
    session.commit()
    session.refresh(document)
    return document
