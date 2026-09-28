from app.services.realtime.processor import (
    _is_likely_repetitive_hallucination,
    _trim_turn_to_commit_range,
)
from app.services.realtime.windows import RealtimeTranscriptionWindow
from app.services.transcription.speaker_turns import SpeakerTurn, SpeakerTurnWord


def test_detects_dominant_short_phrase_repetition() -> None:
    assert _is_likely_repetitive_hallucination(
        "、月額で、月額で、月額で、月額で、月額で、月額で、月額で"
    )
    assert not _is_likely_repetitive_hallucination(
        "月額で二十七万円、各種手当もすべて含まれます"
    )


def test_overlap_context_words_are_removed_before_live_turn_is_stored() -> None:
    turn = SpeakerTurn(
        start_seconds=10.0,
        end_seconds=17.0,
        text="前の発言新しい発言",
        speaker="SPEAKER_00",
        confidence=0.5,
        words=(
            SpeakerTurnWord(10.0, 12.0, "前の発言", 0.4),
            SpeakerTurnWord(16.0, 17.0, "新しい発言", 0.9),
        ),
    )
    window = RealtimeTranscriptionWindow(
        start_ms=15_000,
        end_ms=45_000,
        commit_start_ms=30_000,
    )

    trimmed = _trim_turn_to_commit_range(turn, window)

    assert trimmed is not None
    assert trimmed.start_seconds == 16.0
    assert trimmed.end_seconds == 17.0
    assert trimmed.text == "新しい発言"
    assert [word.text for word in trimmed.words] == ["新しい発言"]
    assert trimmed.confidence == 0.9


def test_untrimmed_overlap_turn_without_word_times_is_not_stored() -> None:
    turn = SpeakerTurn(
        start_seconds=14.0,
        end_seconds=17.0,
        text="境界をまたぐ発言",
        speaker="SPEAKER_00",
        confidence=None,
    )
    window = RealtimeTranscriptionWindow(
        start_ms=15_000,
        end_ms=45_000,
        commit_start_ms=30_000,
    )

    assert _trim_turn_to_commit_range(turn, window) is None
