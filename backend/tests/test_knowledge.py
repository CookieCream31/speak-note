from uuid import UUID

from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.models.meeting import Meeting
from app.services.knowledge.context import build_knowledge_snapshot


def test_project_hierarchy_and_meeting_assignment(client: TestClient) -> None:
    profile = client.post("/api/v1/knowledge/profiles", json={
        "name": "経歴", "body": "Pythonの経験がある"
    })
    assert profile.status_code == 201
    parent = client.post("/api/v1/knowledge/projects", json={
        "name": "就活", "notes": "転職活動", "profile_id": profile.json()["id"]
    })
    assert parent.status_code == 201
    child = client.post("/api/v1/knowledge/projects", json={
        "name": "A社", "notes": "A社の面接", "parent_id": parent.json()["id"]
    })
    assert child.status_code == 201
    third_level = client.post("/api/v1/knowledge/projects", json={
        "name": "深すぎる", "parent_id": child.json()["id"]
    })
    assert third_level.status_code == 422
    meeting = client.post("/api/v1/meetings", json={
        "title": "面接", "source_type": "audio_recording", "project_id": child.json()["id"]
    })
    assert meeting.status_code == 201
    assert meeting.json()["project_id"] == child.json()["id"]
    listed = client.get("/api/v1/meetings", params={"project_id": child.json()["id"]})
    assert listed.status_code == 200
    assert listed.json()["total"] == 1
    moved = client.patch(f"/api/v1/meetings/{meeting.json()['id']}", json={"project_id": None})
    assert moved.status_code == 200
    assert moved.json()["project_id"] is None


def test_knowledge_snapshot_inherits_parent_not_sibling(
    client: TestClient, session_factory: sessionmaker[Session]
) -> None:
    parent = client.post("/api/v1/knowledge/projects", json={
        "name": "就活", "notes": "共通の背景"
    }).json()
    a = client.post("/api/v1/knowledge/projects", json={
        "name": "A社", "notes": "A社の情報", "parent_id": parent["id"]
    }).json()
    b = client.post("/api/v1/knowledge/projects", json={
        "name": "B社", "notes": "B社の情報", "parent_id": parent["id"]
    }).json()
    parent_doc = client.post(f"/api/v1/knowledge/projects/{parent['id']}/documents", json={
        "name": "共通資料", "content": "全社に共通"
    })
    assert parent_doc.status_code == 201
    a_doc = client.post(f"/api/v1/knowledge/projects/{a['id']}/documents", json={
        "name": "A資料", "content": "Aだけ"
    })
    assert a_doc.status_code == 201
    excluded = client.post(f"/api/v1/knowledge/projects/{a['id']}/documents", json={
        "name": "除外資料", "content": "使わない", "included": False
    })
    assert excluded.status_code == 201
    client.post(f"/api/v1/knowledge/projects/{b['id']}/documents", json={
        "name": "B資料", "content": "Bだけ"
    })
    meeting_id = client.post("/api/v1/meetings", json={
        "title": "A面接", "source_type": "live", "project_id": a["id"]
    }).json()["id"]
    with session_factory() as session:
        meeting = session.get(Meeting, UUID(meeting_id))
        assert meeting is not None
        snapshot = build_knowledge_snapshot(session, meeting)
    names = {source["name"] for source in snapshot["sources"]}
    assert names == {"就活", "A社", "共通資料", "A資料"}
    assert "B資料" not in names
    assert "除外資料" not in names

def test_excluded_document_keeps_reference_flag_and_increments_revision(client: TestClient) -> None:
    project = client.post("/api/v1/knowledge/projects", json={"name": " A社 "}).json()
    assert project["name"] == "A社"
    document = client.post(
        f"/api/v1/knowledge/projects/{project['id']}/documents",
        json={"name": "資料", "content": "前の内容", "included": False},
    ).json()
    updated = client.put(
        f"/api/v1/knowledge/projects/{project['id']}/documents/{document['id']}",
        json={"name": "資料", "content": "新しい内容", "included": False},
    )
    assert updated.status_code == 200
    assert updated.json()["included"] is False
    assert updated.json()["revision"] == document["revision"] + 1
    assert updated.json()["content"] == "新しい内容"
    blank = client.post("/api/v1/knowledge/projects", json={"name": "   "})
    assert blank.status_code == 422


def test_profile_snapshot_is_copied_and_child_can_override(
    client: TestClient, session_factory: sessionmaker[Session],
) -> None:
    shared = client.post(
        "/api/v1/knowledge/profiles", json={"name": "共通", "body": "共通経歴"}
    ).json()
    own = client.post(
        "/api/v1/knowledge/profiles", json={"name": "子用", "body": "変更前"}
    ).json()
    parent = client.post(
        "/api/v1/knowledge/projects",
        json={"name": "親", "profile_id": shared["id"]},
    ).json()
    child = client.post(
        "/api/v1/knowledge/projects",
        json={"name": "子", "parent_id": parent["id"], "profile_id": own["id"]},
    ).json()
    meeting_id = client.post(
        "/api/v1/meetings",
        json={"title": "会議", "source_type": "live", "project_id": child["id"]},
    ).json()["id"]
    with session_factory() as session:
        meeting = session.get(Meeting, UUID(meeting_id))
        assert meeting is not None
        before = build_knowledge_snapshot(session, meeting)
    updated = client.put(
        f"/api/v1/knowledge/profiles/{own['id']}",
        json={"name": "子用", "body": "変更後"},
    )
    assert updated.status_code == 200
    with session_factory() as session:
        meeting = session.get(Meeting, UUID(meeting_id))
        assert meeting is not None
        after = build_knowledge_snapshot(session, meeting)
    assert before["sources"][0]["content"] == "変更前"
    assert after["sources"][0]["content"] == "変更後"
    assert before["sources"][0]["id"] != after["sources"][0]["id"]
    assert all(source["name"] != "共通" for source in before["sources"])
