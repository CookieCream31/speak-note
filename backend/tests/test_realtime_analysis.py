import json
import re
import uuid
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import delete, select
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.models.ai import AIProfile, AIProviderConfig, AIProviderType, AIUsage, AIUsageSetting
from app.models.job import Job, JobStatus, JobType
from app.models.meeting import Meeting, MeetingSourceType
from app.models.realtime import RealtimeSession, RealtimeSessionStatus
from app.models.realtime_analysis import RealtimeAnalysisState, RealtimeAnalysisStatus
from app.models.transcript import TranscriptSegment, TranscriptVersion
from app.schemas.realtime_analysis import RealtimeAnalysisOutput
from app.services.analysis.realtime import (
    RealtimeAnalysisError,
    _compact_summary,
    _discard_unverified_superseded,
    _evidence_replacements,
    _remap_snapshot_evidence,
    _stabilize_snapshot,
    _validate_result,
    process_realtime_analysis_job,
    schedule_realtime_analysis,
)
from app.services.media import MediaStorage
from app.services.realtime import start_realtime_session


class FakeRealtimeProvider:
    def __init__(self) -> None:
        self.payloads: list[dict[str, Any]] = []

    async def generate_structured(self, system_prompt, prompt, schema):
        assert "質問文や質問候補は作らない" in system_prompt
        assert "最大6文かつ800文字以内" in system_prompt
        payload = json.loads(prompt[prompt.index("{") :])
        self.payloads.append(payload)
        revision = payload["input_revision"]
        as_of_ms = payload["as_of_ms"]
        markers = re.findall(r"evidence_id=([0-9a-f-]{36})", prompt)
        assert markers
        result = {
            "input_revision": revision,
            "as_of_ms": as_of_ms,
            "summary": {
                "content": f"更新{revision}",
                "evidence_segment_ids": [markers[-1]],
            },
            "decisions": [],
            "action_items": [],
            "attention_items": [],
            "key_facts": [],
        }
        assert schema is RealtimeAnalysisOutput
        return schema.model_validate(result)

    async def test_connection(self) -> None:
        return None

    async def list_models(self) -> list[str]:
        return ["test-model"]


class RevisionAdvancingProvider(FakeRealtimeProvider):
    def __init__(self, session_factory: sessionmaker[Session]) -> None:
        super().__init__()
        self.session_factory = session_factory

    async def generate_structured(self, system_prompt, prompt, schema):
        result = await super().generate_structured(system_prompt, prompt, schema)
        with self.session_factory() as concurrent_session:
            state = concurrent_session.scalar(select(RealtimeAnalysisState))
            assert state is not None
            state.input_revision += 1
            concurrent_session.commit()
        return result


def test_realtime_analysis_rejects_draft_action_evidence() -> None:
    evidence_id = uuid.uuid4()
    result = RealtimeAnalysisOutput.model_validate(
        {
            "input_revision": 1,
            "as_of_ms": 15_000,
            "summary": {
                "content": "暫定要約",
                "evidence_segment_ids": [evidence_id],
            },
            "decisions": [],
            "action_items": [
                {
                    "content": "作業を行う",
                    "evidence_segment_ids": [evidence_id],
                }
            ],
        }
    )
    current = [
        {
            "evidence_id": str(evidence_id),
            "status": "draft",
        }
    ]

    with pytest.raises(RealtimeAnalysisError, match="暫定発言"):
        _validate_result(result, current, 1, 15_000)


def test_realtime_analysis_remaps_reprocessed_evidence_by_time() -> None:
    previous_id = str(uuid.uuid4())
    stable_id = str(uuid.uuid4())
    first_replacement_id = str(uuid.uuid4())
    second_replacement_id = str(uuid.uuid4())
    unrelated_id = str(uuid.uuid4())
    previous_source = [
        {"evidence_id": previous_id, "start_ms": 1_000, "end_ms": 8_000},
        {"evidence_id": stable_id, "start_ms": 10_000, "end_ms": 12_000},
    ]
    current = [
        {"evidence_id": first_replacement_id, "start_ms": 900, "end_ms": 4_000},
        {"evidence_id": second_replacement_id, "start_ms": 4_000, "end_ms": 8_200},
        {"evidence_id": stable_id, "start_ms": 10_000, "end_ms": 12_000},
        {"evidence_id": unrelated_id, "start_ms": 20_000, "end_ms": 22_000},
    ]
    snapshot = {
        "summary": {
            "content": "前回の解析結果です。",
            "evidence_segment_ids": [previous_id, stable_id],
        },
        "decisions": [
            {
                "content": "前回の決定事項です。",
                "status": "explicit",
                "evidence_segment_ids": [previous_id],
            }
        ],
    }

    remapped = _remap_snapshot_evidence(
        snapshot,
        _evidence_replacements(previous_source, current),
    )

    expected = [first_replacement_id, second_replacement_id, stable_id]
    assert remapped is not None
    assert remapped["summary"]["evidence_segment_ids"] == expected
    assert remapped["decisions"][0]["evidence_segment_ids"] == expected[:2]
    assert snapshot["summary"]["evidence_segment_ids"] == [previous_id, stable_id]


def test_realtime_analysis_only_changes_explicitly_superseded_history() -> None:
    evidence_id = uuid.uuid4()
    evidence_ids = [str(evidence_id)]
    previous = {
        "summary": {
            "content": "既存の要約です。維持する内容です。",
            "evidence_segment_ids": evidence_ids,
        },
        "decisions": [
            {
                "content": "旧方針で進める。",
                "status": "explicit",
                "evidence_segment_ids": evidence_ids,
            }
        ],
        "action_items": [
            {
                "content": "資料を作成する。",
                "assignee": "田中",
                "deadline": None,
                "status": "open",
                "evidence_segment_ids": evidence_ids,
            }
        ],
        "attention_items": [
            {
                "type": "missing_information",
                "title": "納期の確認",
                "known_information": "今月中に対応する予定です。",
                "information_needed": "具体的な日付",
                "reason": "作業計画に必要です。",
                "evidence_segment_ids": evidence_ids,
            }
        ],
        "key_facts": [
            {
                "label": "予算",
                "value": "100万円",
                "evidence_segment_ids": evidence_ids,
            }
        ],
    }
    current = [{"evidence_id": str(evidence_id), "status": "confirmed"}]
    additions_only = RealtimeAnalysisOutput.model_validate(
        {
            "input_revision": 2,
            "as_of_ms": 30_000,
            "summary": {
                "content": "既存の要約です。維持する内容です。新しい要約です。",
                "evidence_segment_ids": evidence_ids,
            },
            "decisions": [
                {
                    "content": "旧方針で進める。",
                    "status": "candidate",
                    "evidence_segment_ids": evidence_ids,
                },
                {
                    "content": "追加方針で進める。",
                    "status": "explicit",
                    "evidence_segment_ids": evidence_ids,
                },
            ],
            "action_items": [
                {
                    "content": "資料を作成する。",
                    "assignee": "佐藤",
                    "status": "done",
                    "evidence_segment_ids": evidence_ids,
                },
                {
                    "content": "議事録を共有する。",
                    "assignee": "鈴木",
                    "evidence_segment_ids": evidence_ids,
                },
            ],
            "attention_items": [
                {
                    "type": "missing_information",
                    "title": "納期の確認",
                    "known_information": "納期は明日です。",
                    "information_needed": None,
                    "reason": "解決しました。",
                    "evidence_segment_ids": evidence_ids,
                },
                {
                    "type": "risk",
                    "title": "作業遅延",
                    "known_information": "担当者が不足しています。",
                    "information_needed": None,
                    "reason": "納期に影響する可能性があります。",
                    "evidence_segment_ids": evidence_ids,
                },
            ],
            "key_facts": [
                {
                    "label": "予算",
                    "value": "999万円",
                    "evidence_segment_ids": evidence_ids,
                },
                {
                    "label": "開催場所",
                    "value": "第1会議室",
                    "evidence_segment_ids": evidence_ids,
                },
            ],
        }
    )

    _stabilize_snapshot(previous, additions_only, current)

    assert additions_only.summary.content == "既存の要約です。維持する内容です。新しい要約です。"
    assert [(item.content, item.status) for item in additions_only.decisions] == [
        ("旧方針で進める。", "explicit"),
        ("追加方針で進める。", "explicit"),
    ]
    assert [
        (item.content, item.assignee, item.status) for item in additions_only.action_items
    ] == [
        ("資料を作成する。", "田中", "open"),
        ("議事録を共有する。", "鈴木", "open"),
    ]
    assert [
        (item.title, item.known_information) for item in additions_only.attention_items
    ] == [
        ("納期の確認", "今月中に対応する予定です。"),
        ("作業遅延", "担当者が不足しています。"),
    ]
    assert [(item.label, item.value) for item in additions_only.key_facts] == [
        ("予算", "100万円"),
        ("開催場所", "第1会議室"),
    ]
    schema_properties = RealtimeAnalysisOutput.model_json_schema()["properties"]
    assert "superseded" in schema_properties
    assert "superseded" not in additions_only.model_dump(mode="json")

    repeated_snapshot = RealtimeAnalysisOutput.model_validate(
        {
            "input_revision": 2,
            "as_of_ms": 30_000,
            "summary": {
                "content": "既存の要約です。維持する内容です。新しい要約です。",
                "evidence_segment_ids": evidence_ids,
            },
        }
    )
    _stabilize_snapshot(previous, repeated_snapshot, current)
    assert repeated_snapshot.summary.content == additions_only.summary.content

    corrected = RealtimeAnalysisOutput.model_validate(
        {
            "input_revision": 3,
            "as_of_ms": 60_000,
            "summary": {
                "content": "維持する内容です。訂正後の要約です。",
                "evidence_segment_ids": evidence_ids,
            },
            "decisions": [
                {
                    "content": "新方針で進める。",
                    "status": "explicit",
                    "evidence_segment_ids": evidence_ids,
                }
            ],
            "key_facts": [
                {
                    "label": "予算",
                    "value": "120万円",
                    "evidence_segment_ids": evidence_ids,
                }
            ],
            "superseded": {
                "summary_sentences": [
                    {"index": 0, "evidence_segment_ids": evidence_ids}
                ],
                "decisions": [{"index": 0, "evidence_segment_ids": evidence_ids}],
                "action_items": [{"index": 0, "evidence_segment_ids": evidence_ids}],
                "attention_items": [{"index": 0, "evidence_segment_ids": evidence_ids}],
                "key_facts": [{"index": 0, "evidence_segment_ids": evidence_ids}],
            },
        }
    )

    _validate_result(corrected, current, 3, 60_000, {evidence_id})
    with pytest.raises(RealtimeAnalysisError, match="新しいEvidence"):
        _validate_result(corrected, current, 3, 60_000, set())
    draft_current = [{"evidence_id": str(evidence_id), "status": "draft"}]
    with pytest.raises(RealtimeAnalysisError, match="暫定発言"):
        _validate_result(corrected, draft_current, 3, 60_000, {evidence_id})

    _stabilize_snapshot(previous, corrected, current)

    assert corrected.summary.content == "維持する内容です。訂正後の要約です。"
    assert [item.content for item in corrected.decisions] == ["新方針で進める。"]
    assert corrected.action_items == []
    assert corrected.attention_items == []
    assert [(item.label, item.value) for item in corrected.key_facts] == [
        ("予算", "120万円")
    ]


def test_realtime_summary_is_compact_and_deduplicated() -> None:
    content = "".join([f"要点{index}です。" for index in range(1, 8)])

    assert _compact_summary(f"要点1です。要点1です。{content}") == "".join(
        [f"要点{index}です。" for index in range(1, 7)]
    )


def test_realtime_analysis_discards_unverified_superseded_items() -> None:
    old_evidence_id = uuid.uuid4()
    changed_evidence_id = uuid.uuid4()
    draft_evidence_id = uuid.uuid4()
    result = RealtimeAnalysisOutput.model_validate(
        {
            "input_revision": 2,
            "as_of_ms": 30_000,
            "summary": {
                "content": "短い要約です。",
                "evidence_segment_ids": [changed_evidence_id],
            },
            "superseded": {
                "decisions": [
                    {"index": 0, "evidence_segment_ids": [old_evidence_id]},
                    {"index": 1, "evidence_segment_ids": [changed_evidence_id]},
                    {"index": 2, "evidence_segment_ids": [draft_evidence_id]},
                ]
            },
        }
    )
    current = [
        {"evidence_id": str(old_evidence_id), "status": "confirmed"},
        {"evidence_id": str(changed_evidence_id), "status": "confirmed"},
        {"evidence_id": str(draft_evidence_id), "status": "draft"},
    ]

    _discard_unverified_superseded(result, current, {changed_evidence_id, draft_evidence_id})

    assert [item.index for item in result.superseded.decisions] == [1]
    _validate_result(result, current, 2, 30_000, {changed_evidence_id})


def _seed(
    session: Session,
    tmp_path: Path,
) -> tuple[Meeting, RealtimeSession, TranscriptVersion]:
    meeting = Meeting(title="Realtime AI", source_type=MeetingSourceType.LIVE)
    provider = AIProviderConfig(
        provider_type=AIProviderType.OLLAMA,
        name=f"ollama-{uuid.uuid4()}",
        base_url="http://host.docker.internal:11434",
        enabled=True,
    )
    session.add_all([meeting, provider])
    session.flush()
    profile = AIProfile(
        name=f"realtime-{uuid.uuid4()}",
        provider_id=provider.id,
        model="test-model",
        temperature=0.1,
    )
    session.add(profile)
    session.flush()
    session.add(
        AIUsageSetting(
            usage=AIUsage.REALTIME_ANALYSIS,
            profile_id=profile.id,
            disabled=False,
        )
    )
    session.commit()
    realtime_session = start_realtime_session(
        session,
        meeting,
        MediaStorage(tmp_path, 10, 10),
        mime_type="video/webm",
        has_system_audio=True,
        model="large-v3",
        language="ja",
    )
    transcript = session.get(TranscriptVersion, realtime_session.transcript_version_id)
    assert transcript is not None
    return meeting, realtime_session, transcript


def test_realtime_analysis_sends_only_changed_segments(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    fake = FakeRealtimeProvider()
    with session_factory() as session:
        _meeting, realtime_session, transcript = _seed(session, tmp_path)
        realtime_session.duration_ms = 15_000
        transcript.segments.append(
            TranscriptSegment(
                start_ms=1_000,
                end_ms=8_000,
                text="最初の確定した発言です。",
                provisional_speaker_label="SPEAKER_00",
                sequence=0,
            )
        )
        session.commit()

        state = schedule_realtime_analysis(session, realtime_session, interval_ms=15_000)
        assert state is not None
        first_job = session.scalar(select(Job).where(Job.type == JobType.ANALYZE_REALTIME))
        assert first_job is not None
        process_realtime_analysis_job(
            session,
            first_job,
            get_settings(),
            provider_override=fake,  # type: ignore[arg-type]
        )
        first_evidence_id = fake.payloads[0]["changes"]["upsert_segments"][0][
            "evidence_id"
        ]
        assert "segment_id" not in fake.payloads[0]["changes"]["upsert_segments"][0]

        old_segment_id = transcript.segments[0].id
        session.execute(delete(TranscriptSegment).where(TranscriptSegment.id == old_segment_id))
        session.flush()
        session.add_all(
            [
                TranscriptSegment(
                    transcript_version_id=transcript.id,
                    start_ms=1_000,
                    end_ms=8_000,
                    text="最初の確定した発言です。",
                    provisional_speaker_label="SPEAKER_00",
                    sequence=0,
                ),
                TranscriptSegment(
                    transcript_version_id=transcript.id,
                    start_ms=16_000,
                    end_ms=24_000,
                    text="新しく追加された発言です。",
                    provisional_speaker_label="SPEAKER_01",
                    sequence=1,
                ),
            ]
        )
        realtime_session.duration_ms = 30_000
        session.commit()
        session.expire_all()

        realtime_session = session.get(RealtimeSession, realtime_session.id)
        assert realtime_session is not None
        state = schedule_realtime_analysis(session, realtime_session, interval_ms=15_000)
        assert state is not None
        process_realtime_analysis_job(
            session,
            first_job,
            get_settings(),
            provider_override=fake,  # type: ignore[arg-type]
        )

        second_changes = fake.payloads[1]["changes"]  # type: ignore[index]
        second_upserts = second_changes["upsert_segments"]
        assert len(second_upserts) == 2
        upserts_by_text = {item["text"]: item for item in second_upserts}
        assert set(upserts_by_text) == {
            "最初の確定した発言です。",
            "新しく追加された発言です。",
        }
        assert (
            upserts_by_text["最初の確定した発言です。"]["evidence_id"]
            == first_evidence_id
        )
        assert upserts_by_text["最初の確定した発言です。"]["status"] == "confirmed"
        assert upserts_by_text["新しく追加された発言です。"]["status"] == "draft"
        assert second_changes["removed_evidence_ids"] == []
        assert fake.payloads[1]["context_only"] == []

        realtime_session.status = RealtimeSessionStatus.COMPLETED
        session.commit()
        state = schedule_realtime_analysis(
            session,
            realtime_session,
            force=True,
            interval_ms=15_000,
        )
        assert state is not None
        process_realtime_analysis_job(
            session,
            first_job,
            get_settings(),
            provider_override=fake,  # type: ignore[arg-type]
        )

        final_upserts = fake.payloads[2]["changes"]["upsert_segments"]
        assert len(final_upserts) == 1
        assert final_upserts[0]["text"] == "新しく追加された発言です。"
        assert final_upserts[0]["status"] == "confirmed"


def test_realtime_analysis_publishes_snapshot_before_followup(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    provider = RevisionAdvancingProvider(session_factory)
    with session_factory() as session:
        _meeting, realtime_session, transcript = _seed(session, tmp_path)
        realtime_session.duration_ms = 15_000
        transcript.segments.append(
            TranscriptSegment(
                start_ms=1_000,
                end_ms=8_000,
                text="最初の確定した発言です。",
                provisional_speaker_label="SPEAKER_00",
                sequence=0,
            )
        )
        session.commit()

        state = schedule_realtime_analysis(session, realtime_session, interval_ms=15_000)
        assert state is not None
        job = session.scalar(select(Job).where(Job.type == JobType.ANALYZE_REALTIME))
        assert job is not None
        job.status = JobStatus.RUNNING
        session.commit()

        process_realtime_analysis_job(
            session,
            job,
            get_settings(),
            provider_override=provider,  # type: ignore[arg-type]
        )
        session.expire_all()

        state = session.scalar(select(RealtimeAnalysisState))
        assert state is not None
        assert state.status == RealtimeAnalysisStatus.QUEUED
        assert state.input_revision == 2
        assert state.processed_revision == 1
        assert state.snapshot is not None
        assert state.snapshot["summary"]["content"] == "更新1"
        queued_jobs = list(
            session.scalars(
                select(Job).where(
                    Job.type == JobType.ANALYZE_REALTIME,
                    Job.status == JobStatus.QUEUED,
                )
            )
        )
        assert len(queued_jobs) == 1


def test_realtime_analysis_schedules_at_configured_interval(
    session_factory: sessionmaker[Session],
    tmp_path: Path,
) -> None:
    with session_factory() as session:
        _meeting, realtime_session, transcript = _seed(session, tmp_path)
        transcript.segments.append(
            TranscriptSegment(
                start_ms=1_000,
                end_ms=8_000,
                text="解析間隔を確認する発言です。",
                provisional_speaker_label="SPEAKER_00",
                sequence=0,
            )
        )
        realtime_session.duration_ms = 15_000
        session.commit()

        assert (
            schedule_realtime_analysis(
                session,
                realtime_session,
                interval_ms=30_000,
            )
            is None
        )

        realtime_session.duration_ms = 30_000
        session.commit()
        state = schedule_realtime_analysis(
            session,
            realtime_session,
            interval_ms=30_000,
        )
        assert state is not None
        assert state.input_revision == 1
        assert state.scheduled_through_ms == 30_000

        realtime_session.duration_ms = 45_000
        session.commit()
        state = schedule_realtime_analysis(
            session,
            realtime_session,
            interval_ms=30_000,
        )
        assert state is not None
        assert state.input_revision == 1

        realtime_session.duration_ms = 60_000
        session.commit()
        state = schedule_realtime_analysis(
            session,
            realtime_session,
            interval_ms=30_000,
        )
        assert state is not None
        assert state.input_revision == 2
        assert state.scheduled_through_ms == 60_000
