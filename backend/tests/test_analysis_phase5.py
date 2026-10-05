import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.orm import Session, sessionmaker

from app.core.config import get_settings
from app.models.ai import AIProfile, AIProviderConfig, AIProviderType
from app.models.analysis import (
    AnalysisItemKind,
    AnalysisItemState,
    AnalysisStatus,
)
from app.models.meeting import Meeting, MeetingSourceType, MeetingStatus
from app.models.transcript import (
    TranscriptKind,
    TranscriptSegment,
    TranscriptStatus,
    TranscriptVersion,
)
from app.schemas.analysis import StructuredChaptersOutput, StructuredMinutesOutput
from app.services.analysis import AnalysisProcessingError, create_analysis_job, process_analysis_job
from app.services.analysis.processor import (
    _resolve_evidence_aliases,
    _transcript_prompt,
    _user_prompt,
)


class FakeProvider:
    def __init__(
        self,
        result: dict[str, object],
        chapter_result: dict[str, object] | None = None,
    ) -> None:
        self.result = result
        self.chapter_result = chapter_result
        self.requested_schemas: list[type] = []

    async def generate_structured(self, system_prompt, prompt, schema):
        assert "推測しない" in system_prompt
        assert "segment_id=" in prompt
        self.requested_schemas.append(schema)
        payload = self.chapter_result if schema is StructuredChaptersOutput else self.result
        assert payload is not None
        return schema.model_validate(payload)

    async def test_connection(self) -> None:
        return None

    async def list_models(self) -> list[str]:
        return ["test-model"]


def seed_transcript_and_profile(
    session: Session,
    provider_type: AIProviderType = AIProviderType.OLLAMA,
) -> tuple[Meeting, TranscriptVersion, TranscriptSegment, AIProfile]:
    meeting = Meeting(
        title="Phase 5 meeting",
        source_type=MeetingSourceType.AUDIO_UPLOAD,
        status=MeetingStatus.COMPLETED,
    )
    session.add(meeting)
    session.flush()
    segment = TranscriptSegment(
        start_ms=12000,
        end_ms=18000,
        text="JWT認証を採用します。田中さんが対応します。",
        sequence=0,
    )
    transcript = TranscriptVersion(
        meeting_id=meeting.id,
        version=1,
        kind=TranscriptKind.FINAL,
        status=TranscriptStatus.COMPLETED,
        language="ja",
        model="large-v3",
        diarization_enabled=True,
        segments=[segment],
    )
    provider = AIProviderConfig(
        provider_type=provider_type,
        name=f"{provider_type.value}-{uuid.uuid4()}",
        base_url=(
            "http://host.docker.internal:11434" if provider_type == AIProviderType.OLLAMA else None
        ),
        enabled=True,
    )
    session.add_all([transcript, provider])
    session.flush()
    profile = AIProfile(
        name=f"Profile-{uuid.uuid4()}",
        provider_id=provider.id,
        model="test-model",
        temperature=0.2,
        is_default=True,
    )
    session.add(profile)
    session.flush()
    meeting.active_transcript_version_id = transcript.id
    session.commit()
    return meeting, transcript, segment, profile


def result_for(segment_id: uuid.UUID) -> dict[str, object]:
    evidence = [str(segment_id)]
    return {
        "summary": "JWT認証の採用を決定した。",
        "summary_evidence_segment_ids": evidence,
        "decisions": [{"content": "JWT認証を採用する", "evidence_segment_ids": evidence}],
        "action_items": [
            {
                "content": "認証を実装する",
                "assignee": "田中",
                "deadline": None,
                "evidence_segment_ids": evidence,
            }
        ],
        "open_questions": [],
        "important_points": [],
        "chapters": [
            {
                "title": "認証方式",
                "start_ms": 12000,
                "end_ms": 18000,
                "evidence_segment_ids": evidence,
            }
        ],
        "suggested_questions": [],
        "highlights": [
            {
                "title": "JWT採用の決定",
                "start_ms": 12000,
                "end_ms": 18000,
                "evidence_segment_ids": evidence,
            }
        ],
    }


def test_evidence_aliases_are_mapped_back_to_transcript_segment_ids() -> None:
    segment_id = uuid.uuid4()
    segment = TranscriptSegment(
        id=segment_id,
        start_ms=12000,
        end_ms=18000,
        text="JWT認証を採用します。",
        sequence=0,
    )
    alias = uuid.UUID(int=1)
    result = StructuredMinutesOutput.model_validate(result_for(alias))

    resolved = _resolve_evidence_aliases(result, [segment])

    assert resolved.summary_evidence_segment_ids == [segment_id]
    assert resolved.decisions[0].evidence_segment_ids == [segment_id]
    prompt = _transcript_prompt([segment])
    assert f"segment_id={segment_id}" in prompt
    assert f"evidence_id={alias}" in prompt
    assert "start_ms=12000" in prompt
    assert "end_ms=18000" in prompt


def test_minutes_prompt_includes_summary_format_and_meeting_context() -> None:
    meeting = Meeting(
        title="採用面接",
        source_type=MeetingSourceType.AUDIO_UPLOAD,
        summary_format="detailed",
        meeting_context="候補者は山田さん。SRE職の二次面接。",
    )
    segment = TranscriptSegment(
        start_ms=0,
        end_ms=5000,
        text="運用経験について説明します。",
        sequence=0,
    )

    prompt = _user_prompt(meeting, [segment])

    assert "採用面接" in prompt
    assert "議論の経緯、理由、条件" in prompt
    assert "候補者は山田さん。SRE職の二次面接。" in prompt
    assert "文字起こしにない事実の根拠にはしない" in prompt


def test_ollama_generates_chapters_separately_only_when_missing(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(session)
        analysis, job = create_analysis_job(session, meeting, profile.id)
        minutes = result_for(segment.id)
        minutes["chapters"] = []
        provider = FakeProvider(
            minutes,
            {
                "chapters": [
                    {
                        "title": "追加生成チャプター",
                        "start_ms": segment.start_ms,
                        "end_ms": segment.end_ms,
                        "evidence_segment_ids": [str(segment.id)],
                    }
                ]
            },
        )

        process_analysis_job(
            session,
            job,
            get_settings(),
            provider_override=provider,
        )

        assert provider.requested_schemas == [StructuredMinutesOutput, StructuredChaptersOutput]
        chapter = next(item for item in analysis.items if item.kind == AnalysisItemKind.CHAPTER)
        assert chapter.content == "追加生成チャプター"
        assert [evidence.segment_id for evidence in chapter.evidence] == [segment.id]


def test_gemini_does_not_run_separate_chapter_generation(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(
            session,
            AIProviderType.GEMINI,
        )
        analysis, job = create_analysis_job(session, meeting, profile.id)
        minutes = result_for(segment.id)
        minutes["chapters"] = []
        provider = FakeProvider(minutes)

        process_analysis_job(
            session,
            job,
            get_settings(),
            provider_override=provider,
        )

        assert provider.requested_schemas == [StructuredMinutesOutput]
        assert all(item.kind != AnalysisItemKind.CHAPTER for item in analysis.items)


def test_structured_minutes_accepts_highlight_content_as_title() -> None:
    segment_id = uuid.uuid4()
    payload = result_for(segment_id)
    payload["highlights"] = [
        {
            "content": "JWT採用の重要箇所",
            "start_ms": 12000,
            "end_ms": 18000,
            "evidence_segment_ids": [str(segment_id)],
        }
    ]
    result = StructuredMinutesOutput.model_validate(payload)
    assert result.highlights[0].title == "JWT採用の重要箇所"


def test_structured_minutes_defaults_missing_highlight_title() -> None:
    segment_id = uuid.uuid4()
    payload = result_for(segment_id)
    payload["highlights"] = [
        {
            "start_ms": 12000,
            "end_ms": 18000,
            "evidence_segment_ids": [str(segment_id)],
        }
    ]
    result = StructuredMinutesOutput.model_validate(payload)
    assert result.highlights[0].title == "重要箇所"


def test_analysis_job_stores_structured_items_and_evidence(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, transcript, segment, profile = seed_transcript_and_profile(session)
        analysis, job = create_analysis_job(session, meeting, profile.id)
        process_analysis_job(
            session,
            job,
            get_settings(),
            provider_override=FakeProvider(result_for(segment.id)),
        )

        session.refresh(analysis)
        session.refresh(meeting)
        assert analysis.status == AnalysisStatus.COMPLETED
        assert meeting.active_analysis_version_id == analysis.id
        assert {item.kind for item in analysis.items} >= {
            AnalysisItemKind.SUMMARY,
            AnalysisItemKind.DECISION,
            AnalysisItemKind.ACTION_ITEM,
            AnalysisItemKind.CHAPTER,
            AnalysisItemKind.HIGHLIGHT,
        }
        decision = next(item for item in analysis.items if item.kind == AnalysisItemKind.DECISION)
        assert [item.segment_id for item in decision.evidence] == [segment.id]
        assert decision.start_ms == 12000
        assert decision.end_ms == 18000
        assert transcript.id == analysis.transcript_version_id


def test_invalid_evidence_fails_without_activating_analysis(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(session)
        analysis, job = create_analysis_job(session, meeting, profile.id)
        invalid_result = result_for(segment.id)
        invalid_result["decisions"] = [
            {
                "content": "根拠なし",
                "evidence_segment_ids": [str(uuid.uuid4())],
            }
        ]
        try:
            process_analysis_job(
                session,
                job,
                get_settings(),
                provider_override=FakeProvider(invalid_result),
            )
        except AnalysisProcessingError:
            session.rollback()
        else:
            raise AssertionError("invalid evidence must fail")

        session.refresh(meeting)
        assert meeting.active_analysis_version_id is None
        assert analysis.id is not None


def test_confirmed_item_is_preserved_in_next_analysis(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(session)
        first, first_job = create_analysis_job(session, meeting, profile.id)
        process_analysis_job(
            session,
            first_job,
            get_settings(),
            provider_override=FakeProvider(result_for(segment.id)),
        )
        decision = next(item for item in first.items if item.kind == AnalysisItemKind.DECISION)
        decision.content = "確認済みのJWT決定"
        decision.state = AnalysisItemState.EDITED
        session.commit()

        second, second_job = create_analysis_job(session, meeting, profile.id)
        process_analysis_job(
            session,
            second_job,
            get_settings(),
            provider_override=FakeProvider(result_for(segment.id)),
        )
        assert any(
            item.content == "確認済みのJWT決定" and item.state == AnalysisItemState.EDITED
            for item in second.items
        )
        assert first.id != second.id


def test_search_bookmark_timeline_and_item_edit_api(
    client: TestClient,
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(session)
        analysis, job = create_analysis_job(session, meeting, profile.id)
        process_analysis_job(
            session,
            job,
            get_settings(),
            provider_override=FakeProvider(result_for(segment.id)),
        )
        analysis_id = analysis.id
        decision_id = next(
            item.id for item in analysis.items if item.kind == AnalysisItemKind.DECISION
        )
        meeting_id = meeting.id

    search = client.get(f"/api/v1/meetings/{meeting_id}/search", params={"q": "JWT"})
    assert search.status_code == 200
    assert search.json()[0]["segment_id"] == str(segment.id)

    bookmark = client.post(
        f"/api/v1/meetings/{meeting_id}/bookmarks",
        json={"timestamp_ms": 13000, "title": "確認箇所", "note": "後で見る"},
    )
    assert bookmark.status_code == 201
    assert bookmark.json()["timestamp_ms"] == 13000

    edited = client.patch(
        f"/api/v1/meetings/{meeting_id}/analyses/{analysis_id}/items/{decision_id}",
        json={"content": "JWT認証を採用する（確認済み）"},
    )
    assert edited.status_code == 200
    assert edited.json()["state"] == "edited"

    timeline = client.get(f"/api/v1/meetings/{meeting_id}/timeline")
    assert timeline.status_code == 200
    assert {item["kind"] for item in timeline.json()} >= {"decision", "bookmark", "chapter"}


class SequenceProvider(FakeProvider):
    """Returns each payload in turn and records the prompts it received."""

    def __init__(self, *results: dict[str, object]) -> None:
        super().__init__(results[0])
        self.results = list(results)
        self.prompts: list[str] = []

    async def generate_structured(self, system_prompt, prompt, schema):
        self.prompts.append(prompt)
        self.result = self.results[min(len(self.prompts), len(self.results)) - 1]
        return await super().generate_structured(system_prompt, prompt, schema)


def _result_with_unknown_evidence(segment_id: uuid.UUID) -> dict[str, object]:
    invalid_result = result_for(segment_id)
    invalid_result["decisions"] = [
        {"content": "根拠なし", "evidence_segment_ids": [str(uuid.uuid4())]}
    ]
    return invalid_result


def test_invalid_evidence_is_corrected_by_one_retry(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(session)
        analysis, job = create_analysis_job(session, meeting, profile.id)
        provider = SequenceProvider(
            _result_with_unknown_evidence(segment.id), result_for(segment.id)
        )

        process_analysis_job(session, job, get_settings(), provider_override=provider)

        assert len(provider.prompts) == 2
        assert "前回の出力は検証に失敗しました" not in provider.prompts[0]
        assert "前回の出力は検証に失敗しました" in provider.prompts[1]
        assert "evidence_id" in provider.prompts[1]
        assert analysis.status == AnalysisStatus.COMPLETED
        assert meeting.active_analysis_version_id == analysis.id
        stored_evidence = {
            evidence.segment_id for item in analysis.items for evidence in item.evidence
        }
        assert stored_evidence == {segment.id}


def test_out_of_range_chapter_time_is_corrected_by_one_retry(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(session)
        analysis, job = create_analysis_job(session, meeting, profile.id)
        out_of_range = result_for(segment.id)
        out_of_range["chapters"] = [
            {
                "title": "長すぎる章",
                "start_ms": 0,
                "end_ms": 10_000_000,
                "evidence_segment_ids": [str(segment.id)],
            }
        ]
        provider = SequenceProvider(out_of_range, result_for(segment.id))

        process_analysis_job(session, job, get_settings(), provider_override=provider)

        assert len(provider.prompts) == 2
        assert "end_msは18000以下" in provider.prompts[1]
        assert analysis.status == AnalysisStatus.COMPLETED


def test_invalid_evidence_after_retry_fails_without_storing_it(
    session_factory: sessionmaker[Session],
) -> None:
    with session_factory() as session:
        meeting, _transcript, segment, profile = seed_transcript_and_profile(session)
        analysis, job = create_analysis_job(session, meeting, profile.id)
        provider = SequenceProvider(_result_with_unknown_evidence(segment.id))

        with pytest.raises(AnalysisProcessingError, match="存在しないEvidence"):
            process_analysis_job(session, job, get_settings(), provider_override=provider)
        session.rollback()

        assert len(provider.prompts) == 2
        session.refresh(meeting)
        assert meeting.active_analysis_version_id is None
        assert analysis.items == []
