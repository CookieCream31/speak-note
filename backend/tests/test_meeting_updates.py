from fastapi.testclient import TestClient


def test_update_rejects_null_title_and_status(client: TestClient) -> None:
    meeting = client.post(
        "/api/v1/meetings", json={"title": "Valid", "source_type": "audio_upload"}
    ).json()

    assert (
        client.patch(f"/api/v1/meetings/{meeting['id']}", json={"title": None}).status_code == 422
    )
    assert (
        client.patch(f"/api/v1/meetings/{meeting['id']}", json={"status": None}).status_code == 422
    )
    assert (
        client.patch(
            f"/api/v1/meetings/{meeting['id']}", json={"is_favorite": None}
        ).status_code
        == 422
    )
