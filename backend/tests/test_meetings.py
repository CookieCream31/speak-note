from fastapi.testclient import TestClient


def test_meeting_crud(client: TestClient) -> None:
    create_response = client.post(
        "/api/v1/meetings",
        json={
            "title": " Weekly sync ",
            "source_type": "audio_upload",
            "min_speakers": 2,
            "max_speakers": 4,
            "summary_format": "detailed",
            "meeting_context": " 採用面接。候補者は山田さん。 ",
        },
    )
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["title"] == "Weekly sync"
    assert created["status"] == "created"
    assert created["is_favorite"] is False
    assert created["min_speakers"] == 2
    assert created["max_speakers"] == 4
    assert created["summary_format"] == "detailed"
    assert created["meeting_context"] == "採用面接。候補者は山田さん。"
    meeting_id = created["id"]

    list_response = client.get("/api/v1/meetings")
    assert list_response.status_code == 200
    assert list_response.json()["total"] == 1
    assert list_response.json()["items"][0]["id"] == meeting_id

    update_response = client.patch(
        f"/api/v1/meetings/{meeting_id}",
        json={"title": "Updated sync", "status": "completed", "duration_ms": 65000},
    )
    assert update_response.status_code == 200
    assert update_response.json()["title"] == "Updated sync"
    assert update_response.json()["duration_ms"] == 65000

    get_response = client.get(f"/api/v1/meetings/{meeting_id}")
    assert get_response.status_code == 200
    assert get_response.json()["status"] == "completed"

    speaker_update_response = client.patch(
        f"/api/v1/meetings/{meeting_id}",
        json={"min_speakers": None, "max_speakers": None},
    )
    assert speaker_update_response.status_code == 200
    assert speaker_update_response.json()["min_speakers"] is None
    assert speaker_update_response.json()["max_speakers"] is None

    delete_response = client.delete(f"/api/v1/meetings/{meeting_id}")
    assert delete_response.status_code == 204
    assert client.get(f"/api/v1/meetings/{meeting_id}").status_code == 404


def test_microphone_recording_meeting_can_be_created(client: TestClient) -> None:
    response = client.post(
        "/api/v1/meetings",
        json={
            "title": "Voice memo",
            "source_type": "audio_recording",
            "summary_format": "concise",
        },
    )

    assert response.status_code == 201
    assert response.json()["source_type"] == "audio_recording"
    assert response.json()["summary_format"] == "concise"


def test_meeting_rejects_invalid_summary_preferences(client: TestClient) -> None:
    invalid_format = client.post(
        "/api/v1/meetings",
        json={
            "title": "Invalid format",
            "source_type": "media_upload",
            "summary_format": "essay",
        },
    )
    assert invalid_format.status_code == 422

    context_too_long = client.post(
        "/api/v1/meetings",
        json={
            "title": "Long context",
            "source_type": "media_upload",
            "meeting_context": "x" * 4001,
        },
    )
    assert context_too_long.status_code == 422


def test_favorite_and_bulk_manage_meetings(client: TestClient) -> None:
    meeting_ids = [
        client.post(
            "/api/v1/meetings",
            json={"title": f"Meeting {index}", "source_type": "audio_upload"},
        ).json()["id"]
        for index in range(3)
    ]

    favorite_response = client.patch(
        f"/api/v1/meetings/{meeting_ids[0]}", json={"is_favorite": True}
    )
    assert favorite_response.status_code == 200
    assert favorite_response.json()["is_favorite"] is True

    bulk_favorite_response = client.post(
        "/api/v1/meetings/bulk-actions",
        json={"meeting_ids": meeting_ids[1:], "action": "favorite"},
    )
    assert bulk_favorite_response.status_code == 200
    assert bulk_favorite_response.json() == {"action": "favorite", "affected": 2}
    assert all(item["is_favorite"] for item in client.get("/api/v1/meetings").json()["items"])

    bulk_unfavorite_response = client.post(
        "/api/v1/meetings/bulk-actions",
        json={"meeting_ids": meeting_ids[:2], "action": "unfavorite"},
    )
    assert bulk_unfavorite_response.status_code == 200
    assert bulk_unfavorite_response.json()["affected"] == 2
    remaining_favorite = client.get(f"/api/v1/meetings/{meeting_ids[2]}").json()
    assert remaining_favorite["is_favorite"] is True

    bulk_delete_response = client.post(
        "/api/v1/meetings/bulk-actions",
        json={"meeting_ids": meeting_ids[:2], "action": "delete"},
    )
    assert bulk_delete_response.status_code == 200
    assert bulk_delete_response.json() == {"action": "delete", "affected": 2}
    assert client.get("/api/v1/meetings").json()["total"] == 1


def test_bulk_manage_is_atomic_when_a_meeting_is_missing(client: TestClient) -> None:
    meeting_id = client.post(
        "/api/v1/meetings", json={"title": "Keep", "source_type": "live"}
    ).json()["id"]
    missing_id = "00000000-0000-4000-8000-000000000000"

    response = client.post(
        "/api/v1/meetings/bulk-actions",
        json={"meeting_ids": [meeting_id, missing_id], "action": "delete"},
    )

    assert response.status_code == 404
    assert client.get(f"/api/v1/meetings/{meeting_id}").status_code == 200


def test_assign_and_remove_tag_from_multiple_meetings(client: TestClient) -> None:
    meeting_ids = [
        client.post(
            "/api/v1/meetings",
            json={"title": f"Tagged {index}", "source_type": "audio_upload"},
        ).json()["id"]
        for index in range(2)
    ]
    tag = client.post("/api/v1/tags", json={"name": "採用"}).json()

    missing_tag_response = client.post(
        "/api/v1/meetings/bulk-actions",
        json={"meeting_ids": meeting_ids, "action": "tag"},
    )
    assert missing_tag_response.status_code == 422

    assign_response = client.post(
        "/api/v1/meetings/bulk-actions",
        json={"meeting_ids": meeting_ids, "action": "tag", "tag_id": tag["id"]},
    )
    assert assign_response.status_code == 200
    assert assign_response.json() == {"action": "tag", "affected": 2}
    assert all(
        item["tags"] == [tag]
        for item in client.get("/api/v1/meetings").json()["items"]
    )

    remove_response = client.post(
        "/api/v1/meetings/bulk-actions",
        json={"meeting_ids": [meeting_ids[0]], "action": "untag", "tag_id": tag["id"]},
    )
    assert remove_response.status_code == 200
    assert client.get(f"/api/v1/meetings/{meeting_ids[0]}").json()["tags"] == []
    assert client.get(f"/api/v1/meetings/{meeting_ids[1]}").json()["tags"][0]["id"] == tag["id"]


def test_rejects_blank_title_and_invalid_duration(client: TestClient) -> None:
    blank_response = client.post("/api/v1/meetings", json={"title": "   ", "source_type": "live"})
    assert blank_response.status_code == 422

    created = client.post(
        "/api/v1/meetings", json={"title": "Valid", "source_type": "video_upload"}
    ).json()
    duration_response = client.patch(f"/api/v1/meetings/{created['id']}", json={"duration_ms": -1})
    assert duration_response.status_code == 422


def test_rejects_invalid_speaker_bounds(client: TestClient) -> None:
    invalid_minimum = client.post(
        "/api/v1/meetings",
        json={"title": "Invalid", "source_type": "live", "min_speakers": 0},
    )
    assert invalid_minimum.status_code == 422

    reversed_bounds = client.post(
        "/api/v1/meetings",
        json={
            "title": "Invalid",
            "source_type": "live",
            "min_speakers": 4,
            "max_speakers": 2,
        },
    )
    assert reversed_bounds.status_code == 422

    meeting = client.post(
        "/api/v1/meetings",
        json={"title": "Valid", "source_type": "live", "min_speakers": 3},
    ).json()
    incompatible_update = client.patch(
        f"/api/v1/meetings/{meeting['id']}",
        json={"max_speakers": 2},
    )
    assert incompatible_update.status_code == 422
