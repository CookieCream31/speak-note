"""Resolve meeting knowledge without crossing sibling project boundaries."""

from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.models.knowledge import PersonalProfile, Project, ProjectDocument
from app.models.meeting import Meeting


def project_path(session: Session, project: Project) -> list[Project]:
    if project.parent_id is None:
        return [project]
    parent = session.get(Project, project.parent_id)
    return [parent, project] if parent is not None else [project]


def build_knowledge_snapshot(session: Session, meeting: Meeting) -> dict[str, Any]:
    """Copy exact source revisions; this function does not send data to an AI."""
    sources: list[dict[str, Any]] = []
    if meeting.project_id is not None:
        project = session.get(Project, meeting.project_id)
        if project is not None:
            path = project_path(session, project)
            profile_id = next(
                (item.profile_id for item in reversed(path) if item.profile_id), None
            )
            if profile_id:
                profile = session.get(PersonalProfile, profile_id)
                if profile is not None and profile.body.strip():
                    sources.append({
                        "id": f"profile:{profile.id}:{profile.revision}",
                        "name": profile.name,
                        "content": profile.body.strip(),
                    })
            for item in path:
                if item.notes.strip():
                    sources.append({
                        "id": f"project:{item.id}:{item.revision}",
                        "name": item.name,
                        "content": item.notes.strip(),
                    })
                documents = session.scalars(
                    select(ProjectDocument).where(
                        ProjectDocument.project_id == item.id,
                        ProjectDocument.included.is_(True),
                    ).order_by(ProjectDocument.created_at, ProjectDocument.id)
                )
                for document in documents:
                    sources.append({
                        "id": f"document:{document.id}:{document.revision}",
                        "name": document.name,
                        "content": document.content.strip(),
                    })
    if meeting.meeting_context:
        sources.append({
            "id": f"meeting:{meeting.id}",
            "name": "会議の背景",
            "content": meeting.meeting_context,
        })
    return {
        "meeting_id": str(meeting.id),
        "project_id": str(meeting.project_id) if meeting.project_id else None,
        "sources": sources,
    }
