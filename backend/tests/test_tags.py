from fastapi.testclient import TestClient


def test_tag_crud_normalizes_name_and_rejects_duplicates(client: TestClient) -> None:
    create_response = client.post("/api/v1/tags", json={"name": "  Project   Alpha  "})
    assert create_response.status_code == 201
    created = create_response.json()
    assert created["name"] == "Project Alpha"

    list_response = client.get("/api/v1/tags")
    assert list_response.status_code == 200
    assert [tag["id"] for tag in list_response.json()] == [created["id"]]

    duplicate_response = client.post("/api/v1/tags", json={"name": "project alpha"})
    assert duplicate_response.status_code == 409

    delete_response = client.delete(f"/api/v1/tags/{created['id']}")
    assert delete_response.status_code == 204
    assert client.get("/api/v1/tags").json() == []


def test_rejects_blank_tag_name(client: TestClient) -> None:
    assert client.post("/api/v1/tags", json={"name": "   "}).status_code == 422
