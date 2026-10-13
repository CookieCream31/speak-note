import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import func, select
from sqlalchemy.orm import Session, sessionmaker

from app.models.job import Job
from app.models.media import Media, MediaKind
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.speaker import Speaker
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
    TranscriptWord,
)
from app.services.analysis.processor import _transcript_prompt


@pytest.fixture
def saved_live(session_factory: sessionmaker[Session]) -> dict[str, object]:
    with session_factory() as session:
        meeting = Meeting(
            title="Saved Live",
            source_type=MeetingSourceType.AUDIO_RECORDING,
            status=MeetingStatus.COMPLETED,
        )
        other = Meeting(title="Other", source_type=MeetingSourceType.AUDIO_RECORDING)
        session.add_all([meeting, other])
        session.flush()
        versions = []
        for owner, kind, version in [
            (meeting, TranscriptKind.LIVE, 1),
            (meeting, TranscriptKind.FINAL, 1),
            (other, TranscriptKind.LIVE, 1),
            (meeting, TranscriptKind.LIVE, 2),
        ]:
            transcript = TranscriptVersion(
                meeting_id=owner.id,
                version=version,
                kind=kind,
                status=TranscriptStatus.COMPLETED,
                model="test",
                language="ja",
                diarization_enabled=True,
            )
            for sequence, label in enumerate(["話者 1", "話者 1", "話者 2", "話者 1"]):
                segment = TranscriptSegment(
                    start_ms=sequence * 1000,
                    end_ms=(sequence + 1) * 1000,
                    sequence=sequence,
                    text=f"発言 {sequence}",
                    provisional_speaker_label=label,
                )
                segment.words.append(
                    TranscriptWord(
                        start_ms=segment.start_ms,
                        end_ms=segment.end_ms,
                        sequence=0,
                        text=segment.text,
                        confidence=0.9,
                    )
                )
                transcript.segments.append(segment)
            session.add(transcript)
            versions.append(transcript)
        speaker = Speaker(
            meeting_id=meeting.id, internal_name="SPEAKER_00", display_name="確定話者"
        )
        versions[1].segments[0].speaker = speaker
        session.add(speaker)
        session.flush()
        meeting.active_transcript_version_id = versions[0].id
        session.commit()
        return {
            "meeting_id": meeting.id,
            "version_id": versions[0].id,
            "ids": [segment.id for segment in versions[0].segments],
            "final_id": versions[1].segments[0].id,
            "other_id": versions[2].segments[0].id,
            "other_version_id": versions[3].segments[0].id,
        }


def rename(client: TestClient, saved: dict[str, object], ids: list[uuid.UUID], name: str | None):
    return client.patch(
        f"/api/v1/meetings/{saved['meeting_id']}/transcript/live-speaker-name",
        json={"segment_ids": [str(id_) for id_ in ids], "display_name": name},
    )


def test_saved_live_name_preserves_original_labels_words_final_and_jobs(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_live: dict[str, object],
) -> None:
    ids = saved_live["ids"]
    response = rename(client, saved_live, ids[:2], "  エージェント  ")
    assert response.status_code == 200
    assert [row["provisional_speaker_name"] for row in response.json()] == ["エージェント"] * 2
    assert all(row["speaker"] is None for row in response.json())
    transcript = client.get(f"/api/v1/meetings/{saved_live['meeting_id']}/transcript").json()
    assert [row["provisional_speaker_name"] for row in transcript["segments"]] == [
        "エージェント",
        "エージェント",
        None,
        None,
    ]
    download = client.get(f"/api/v1/meetings/{saved_live['meeting_id']}/transcript/download")
    assert download.status_code == 200
    assert "エージェント" in download.text and "話者 1" in download.text
    with session_factory() as session:
        segment = session.get(TranscriptSegment, ids[0])
        assert segment.provisional_speaker_label == "話者 1"
        assert segment.speaker_id is None and len(segment.words) == 1
        assert segment.text == "発言 0"
        assert "speaker=エージェント（暫定）" in _transcript_prompt([segment])
        final = session.get(TranscriptSegment, saved_live["final_id"])
        assert final.provisional_speaker_name is None
        assert final.speaker.display_name == "確定話者"
        assert session.scalar(select(func.count()).select_from(Speaker)) == 1
        assert session.scalar(select(func.count()).select_from(Job)) == 0


@pytest.mark.parametrize("invalid_key", ["other_id", "final_id", "missing"])
def test_invalid_selection_does_not_partially_save(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_live: dict[str, object],
    invalid_key: str,
) -> None:
    invalid_id = uuid.uuid4() if invalid_key == "missing" else saved_live[invalid_key]
    ids = saved_live["ids"]
    assert rename(client, saved_live, [ids[0], invalid_id], "変更しない").status_code == 404
    with session_factory() as session:
        assert session.get(TranscriptSegment, ids[0]).provisional_speaker_name is None


@pytest.mark.parametrize("selection", ["gap", "mixed_labels", "mixed_versions", "mixed_names"])
def test_names_only_apply_to_one_contiguous_displayed_turn(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_live: dict[str, object],
    selection: str,
) -> None:
    ids = saved_live["ids"]
    chosen = [ids[0], ids[3]]
    if selection == "mixed_labels":
        chosen = ids[:3]
    elif selection == "mixed_versions":
        chosen = [ids[0], saved_live["other_version_id"]]
    elif selection == "mixed_names":
        with session_factory() as session:
            session.get(TranscriptSegment, ids[1]).provisional_speaker_name = "以前の編集"
            session.commit()
        chosen = ids[:2]
    assert rename(client, saved_live, chosen, "変更しない").status_code == 409
    with session_factory() as session:
        assert session.get(TranscriptSegment, ids[0]).provisional_speaker_name is None


@pytest.mark.parametrize("state", ["recording", "finalizing", "meeting_recording", "processing"])
def test_name_changes_wait_for_recording_and_live_save(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_live: dict[str, object],
    state: str,
) -> None:
    with session_factory() as session:
        if state == "meeting_recording":
            session.get(Meeting, saved_live["meeting_id"]).status = MeetingStatus.RECORDING
        elif state == "processing":
            session.get(
                TranscriptVersion, saved_live["version_id"]
            ).status = TranscriptStatus.PROCESSING
        else:
            media = Media(
                meeting_id=saved_live["meeting_id"],
                kind=MediaKind.ORIGINAL_AUDIO,
                storage_path="test/audio.webm",
                mime_type="audio/webm",
                size_bytes=1,
            )
            session.add(media)
            session.flush()
            session.add(
                RealtimeSession(
                    meeting_id=saved_live["meeting_id"],
                    media_id=media.id,
                    transcript_version_id=saved_live["version_id"],
                    status=RealtimeSessionStatus(state),
                    mime_type="audio/webm",
                )
            )
        session.commit()
    ids = saved_live["ids"]
    assert rename(client, saved_live, ids[:2], "保存しない").status_code == (
        404 if state == "processing" else 409
    )
    with session_factory() as session:
        assert session.get(TranscriptSegment, ids[0]).provisional_speaker_name is None


def test_name_validation_and_clear_keep_existing_data(
    client: TestClient,
    saved_live: dict[str, object],
) -> None:
    ids = saved_live["ids"]
    assert rename(client, saved_live, ids[:2], "以前の名前").status_code == 200
    assert rename(client, saved_live, ids[:2], "a" * 201).status_code == 422
    assert rename(client, saved_live, [], "空の対象").status_code == 422
    transcript = client.get(f"/api/v1/meetings/{saved_live['meeting_id']}/transcript").json()
    assert transcript["segments"][0]["provisional_speaker_name"] == "以前の名前"
    for name in [" ", None]:
        assert rename(client, saved_live, ids[:2], name).status_code == 200
    transcript = client.get(f"/api/v1/meetings/{saved_live['meeting_id']}/transcript").json()
    assert transcript["segments"][0]["provisional_speaker_name"] is None
    assert transcript["segments"][0]["provisional_speaker_label"] == "話者 1"


@pytest.mark.parametrize("label", [None, "SPEAKER_UNKNOWN"])
def test_unknown_speakers_are_named_individually(
    client: TestClient,
    session_factory: sessionmaker[Session],
    saved_live: dict[str, object],
    label: str | None,
) -> None:
    ids = saved_live["ids"]
    with session_factory() as session:
        for id_ in ids[:2]:
            session.get(TranscriptSegment, id_).provisional_speaker_label = label
        session.commit()
    assert rename(client, saved_live, ids[:2], "まとめない").status_code == 409
    assert rename(client, saved_live, ids[:1], "単独の発言").status_code == 200
    with session_factory() as session:
        assert session.get(TranscriptSegment, ids[0]).provisional_speaker_name == "単独の発言"
        assert session.get(TranscriptSegment, ids[1]).provisional_speaker_name is None
