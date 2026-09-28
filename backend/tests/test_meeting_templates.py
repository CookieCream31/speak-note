from fastapi.testclient import TestClient


def template_definition(title: str = "議題") -> dict:
    return {
        "realtime": [
            {
                "id": "live-summary",
                "title": "要約",
                "core_kind": "summary",
                "visible": True,
                "fields": [],
            }
        ],
        "final": [
            {
                "id": "custom",
                "title": title,
                "visible": True,
                "fields": [
                    {
                        "id": "status",
                        "name": "状態",
                        "type": "single_select",
                        "options": ["未着手", "完了"],
                    }
                ],
            }
        ],
    }


def test_template_crud_revision_default_and_meeting_snapshot(client: TestClient) -> None:
    created = client.post(
        "/api/v1/meeting-templates",
        json={"name": "  定例会議  ", "definition": template_definition(), "is_default": True},
    )
    assert created.status_code == 201
    template = created.json()
    assert template["name"] == "定例会議"
    assert template["revision"] == 1
    assert template["is_default"] is True

    assert client.get("/api/v1/meeting-templates/default").json()["id"] == template["id"]
    templates_response = client.get("/api/v1/meeting-templates")
    assert [item["id"] for item in templates_response.json()] == [template["id"]]

    meeting = client.post(
        "/api/v1/meetings",
        json={"title": "Snapshot meeting", "source_type": "audio_upload"},
    )
    assert meeting.status_code == 201
    snapshot = meeting.json()["template_snapshot"]
    assert snapshot["template_id"] == template["id"]
    assert snapshot["revision"] == 1
    assert snapshot["definition"]["final"][0]["title"] == "議題"

    updated = client.patch(
        f"/api/v1/meeting-templates/{template['id']}",
        json={"expected_revision": 1, "definition": template_definition("更新後")},
    )
    assert updated.status_code == 200
    assert updated.json()["revision"] == 2
    assert updated.json()["definition"]["final"][0]["title"] == "更新後"
    meeting_id = meeting.json()["id"]
    fetched_meeting = client.get(f"/api/v1/meetings/{meeting_id}").json()
    assert fetched_meeting["template_snapshot"] == snapshot

    stale_update = client.patch(
        f"/api/v1/meeting-templates/{template['id']}",
        json={"expected_revision": 1, "name": "Stale"},
    )
    assert stale_update.status_code == 409


def test_template_validation_default_protection_and_delete(client: TestClient) -> None:
    invalid = template_definition()
    invalid["final"][0]["fields"][0]["options"] = ["同じ", "同じ"]
    invalid_response = client.post(
        "/api/v1/meeting-templates", json={"name": "Invalid", "definition": invalid}
    )
    assert invalid_response.status_code == 422

    default = client.post(
        "/api/v1/meeting-templates",
        json={"name": "Default", "definition": template_definition(), "is_default": True},
    ).json()
    other = client.post(
        "/api/v1/meeting-templates",
        json={"name": "Other", "definition": template_definition()},
    ).json()

    assert client.delete(f"/api/v1/meeting-templates/{default['id']}").status_code == 422
    assert client.patch(
        f"/api/v1/meeting-templates/{default['id']}", json={"is_default": False}
    ).status_code == 422
    promoted = client.patch(
        f"/api/v1/meeting-templates/{other['id']}", json={"is_default": True}
    )
    assert promoted.json()["is_default"] is True
    assert client.get("/api/v1/meeting-templates/default").json()["id"] == other["id"]
    assert client.delete(f"/api/v1/meeting-templates/{default['id']}").status_code == 204
    assert client.delete(f"/api/v1/meeting-templates/{other['id']}").status_code == 422
    missing = "00000000-0000-4000-8000-000000000099"
    assert client.delete(f"/api/v1/meeting-templates/{missing}").status_code == 404


def test_meeting_rejects_missing_template_id(client: TestClient) -> None:
    response = client.post(
        "/api/v1/meetings",
        json={
            "title": "Missing template",
            "source_type": "audio_upload",
            "template_id": "00000000-0000-4000-8000-000000000099",
        },
    )
    assert response.status_code == 404
