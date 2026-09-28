from dataclasses import dataclass, field
from statistics import fmean

from app.services.transcription.schemas import WhisperXResult, WhisperXSegment


@dataclass(frozen=True)
class SpeakerTurnWord:
    start_seconds: float
    end_seconds: float
    text: str
    confidence: float | None


@dataclass(frozen=True)
class SpeakerTurn:
    start_seconds: float
    end_seconds: float
    text: str
    speaker: str | None
    confidence: float | None
    words: tuple[SpeakerTurnWord, ...] = field(default_factory=tuple)


def _fallback_turn(segment: WhisperXSegment) -> SpeakerTurn:
    confidence = segment.confidence if segment.confidence is not None else segment.score
    return SpeakerTurn(
        start_seconds=segment.start,
        end_seconds=max(segment.start, segment.end),
        text=segment.text.strip(),
        speaker=segment.speaker,
        confidence=confidence,
    )


def _word_turns(segment: WhisperXSegment) -> list[SpeakerTurn]:
    turns: list[SpeakerTurn] = []
    current_speaker: str | None = None
    current_words: list[str] = []
    current_timed_words: list[SpeakerTurnWord] = []
    current_scores: list[float] = []
    current_start: float | None = None
    current_end: float | None = None

    def flush() -> None:
        nonlocal current_words, current_timed_words, current_scores, current_start, current_end
        text = "".join(current_words).strip()
        if text:
            all_words_have_timing = len(current_timed_words) == len(current_words)
            turns.append(
                SpeakerTurn(
                    start_seconds=current_start if current_start is not None else segment.start,
                    end_seconds=max(
                        current_start if current_start is not None else segment.start,
                        current_end if current_end is not None else segment.end,
                    ),
                    text=text,
                    speaker=current_speaker,
                    confidence=fmean(current_scores) if current_scores else None,
                    words=tuple(current_timed_words) if all_words_have_timing else (),
                )
            )
        current_words = []
        current_timed_words = []
        current_scores = []
        current_start = None
        current_end = None

    for word in segment.words:
        if not word.word:
            continue
        word_speaker = word.speaker or current_speaker or segment.speaker
        if current_words and word_speaker != current_speaker:
            flush()
        if not current_words:
            current_speaker = word_speaker
        current_words.append(word.word)
        if word.score is not None:
            current_scores.append(word.score)
        if word.start is not None and current_start is None:
            current_start = word.start
        if word.end is not None:
            current_end = word.end
        if word.start is not None and word.end is not None:
            current_timed_words.append(
                SpeakerTurnWord(
                    start_seconds=word.start,
                    end_seconds=max(word.start, word.end),
                    text=word.word,
                    confidence=word.score,
                )
            )
    flush()
    return turns


def build_speaker_turns(result: WhisperXResult) -> list[SpeakerTurn]:
    turns: list[SpeakerTurn] = []
    for segment in result.segments:
        word_turns = _word_turns(segment) if segment.words else []
        if word_turns:
            turns.extend(word_turns)
        elif segment.text.strip():
            turns.append(_fallback_turn(segment))
    return turns
