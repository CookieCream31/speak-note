from pydantic import TypeAdapter, ValidationError

from app.schemas.transcript import TranscriptWordTiming

_WORD_TIMINGS = TypeAdapter(list[TranscriptWordTiming])


def validate_streaming_words(
    value: object, *, text: str, start_ms: int, end_ms: int
) -> list[TranscriptWordTiming] | None:
    if value is None:
        return None
    if not isinstance(value, list) or len(value) > 5000:
        raise ValueError("認識結果の単語情報が不正です")
    try:
        words = _WORD_TIMINGS.validate_python(value)
    except ValidationError as exc:
        raise ValueError("認識結果の単語情報が不正です") from exc
    previous_start = start_ms
    for word in words:
        if not start_ms <= word.start_ms <= word.end_ms <= end_ms:
            raise ValueError("認識結果の単語時刻が発言の範囲外です")
        if word.start_ms < previous_start:
            raise ValueError("認識結果の単語順が不正です")
        previous_start = word.start_ms
    if words and "".join(word.text for word in words) != text.strip():
        raise ValueError("認識結果の単語と本文が一致しません")
    return words
