from typing import Any

from sqlalchemy.orm import Session

from app.models.meeting import Meeting, MeetingSourceType
from app.models.transcription import AsyncTranscriptionSettings, RealtimeTranscriptionSettings
from app.schemas.transcription_language import TranscriptionLanguageOptionsRead

# Soniox's documented ISO codes. The selected model is checked again before sending audio.
LANGUAGES = [
    "ja",
    "en",
    "zh",
    "ko",
    "fr",
    "de",
    "es",
    "pt",
    "it",
    "ru",
    "af",
    "sq",
    "ar",
    "az",
    "eu",
    "be",
    "bn",
    "bs",
    "bg",
    "ca",
    "hr",
    "cs",
    "da",
    "nl",
    "et",
    "fi",
    "gl",
    "el",
    "gu",
    "he",
    "hi",
    "hu",
    "id",
    "kn",
    "kk",
    "lv",
    "lt",
    "mk",
    "ms",
    "ml",
    "mr",
    "no",
    "fa",
    "pl",
    "pa",
    "ro",
    "sr",
    "sk",
    "sl",
    "sw",
    "sv",
    "tl",
    "ta",
    "te",
    "th",
    "tr",
    "uk",
    "ur",
    "vi",
    "cy",
]

# A single default locale per language for the existing Azure recognizer.
AZURE_LOCALES = dict(
    zip(
        [
            "ja",
            "en",
            "zh",
            "ko",
            "fr",
            "de",
            "es",
            "pt",
            "it",
            "ru",
            "af",
            "sq",
            "ar",
            "az",
            "eu",
            "bn",
            "bs",
            "bg",
            "ca",
            "hr",
            "cs",
            "da",
            "nl",
            "et",
            "fi",
            "gl",
            "el",
            "gu",
            "he",
            "hi",
            "hu",
            "id",
            "kn",
            "kk",
            "lv",
            "lt",
            "mk",
            "ms",
            "ml",
            "mr",
            "no",
            "fa",
            "pl",
            "pa",
            "ro",
            "sr",
            "sk",
            "sl",
            "sw",
            "sv",
            "tl",
            "ta",
            "te",
            "th",
            "tr",
            "uk",
            "ur",
            "vi",
            "cy",
        ],
        [
            "ja-JP",
            "en-US",
            "zh-CN",
            "ko-KR",
            "fr-FR",
            "de-DE",
            "es-ES",
            "pt-BR",
            "it-IT",
            "ru-RU",
            "af-ZA",
            "sq-AL",
            "ar-SA",
            "az-AZ",
            "eu-ES",
            "bn-IN",
            "bs-BA",
            "bg-BG",
            "ca-ES",
            "hr-HR",
            "cs-CZ",
            "da-DK",
            "nl-NL",
            "et-EE",
            "fi-FI",
            "gl-ES",
            "el-GR",
            "gu-IN",
            "he-IL",
            "hi-IN",
            "hu-HU",
            "id-ID",
            "kn-IN",
            "kk-KZ",
            "lv-LV",
            "lt-LT",
            "mk-MK",
            "ms-MY",
            "ml-IN",
            "mr-IN",
            "nb-NO",
            "fa-IR",
            "pl-PL",
            "pa-IN",
            "ro-RO",
            "sr-RS",
            "sk-SK",
            "sl-SI",
            "sw-KE",
            "sv-SE",
            "fil-PH",
            "ta-IN",
            "te-IN",
            "th-TH",
            "tr-TR",
            "uk-UA",
            "ur-IN",
            "vi-VN",
            "cy-GB",
        ],
        strict=True,
    )
)


class TranscriptionLanguageError(ValueError):
    pass


def language_options(db: Session, *, include_realtime: bool) -> TranscriptionLanguageOptionsRead:
    asynchronous = db.get(AsyncTranscriptionSettings, 1)
    providers = [asynchronous.provider if asynchronous else "whisperx"]
    if include_realtime:
        realtime = db.get(RealtimeTranscriptionSettings, 1)
        providers.append(realtime.provider if realtime else "whisperx")
    providers = list(dict.fromkeys(providers))
    return TranscriptionLanguageOptionsRead(
        languages=[
            code for code in LANGUAGES if "azure_speech" not in providers or code in AZURE_LOCALES
        ],
        supports_auto=all(provider == "soniox" for provider in providers),
        supports_multiple=all(provider == "soniox" for provider in providers),
        supports_strict="soniox" in providers,
        providers=providers,
    )


def validate_meeting_languages(
    db: Session, meeting: Meeting, hints: list[str] | None, strict: bool
) -> None:
    if hints is None and not strict:
        return  # Legacy meetings keep their separate historical defaults.
    options = language_options(
        db,
        include_realtime=meeting.source_type
        in {
            MeetingSourceType.LIVE,
            MeetingSourceType.SHARED_AUDIO,
            MeetingSourceType.AUDIO_RECORDING,
        },
    )
    if hints is None or (strict and not hints):
        raise TranscriptionLanguageError("言語を選択してからStrictを有効にしてください")
    if not hints and not options.supports_auto:
        raise TranscriptionLanguageError(
            "自動判定はSonioxで使用できます。現在のエンジンでは言語を1つ選択してください"
        )
    if len(hints) > 1 and not options.supports_multiple:
        raise TranscriptionLanguageError(
            "複数言語はSonioxで使用できます。現在のエンジンでは言語を1つ選択してください"
        )
    if any(code not in options.languages for code in hints):
        raise TranscriptionLanguageError(
            "現在の文字起こしエンジンで使用できる言語を選択してください"
        )
    if strict and not options.supports_strict:
        raise TranscriptionLanguageError("Strict language hintsはSonioxで使用できます")


def provider_language(
    meeting: Meeting | None, provider: str, fallback: str
) -> tuple[str, dict[str, Any]]:
    hints = meeting.transcription_language_hints if meeting is not None else None
    if hints is None:
        return fallback, {}
    if provider == "soniox":
        strict = bool(meeting and meeting.transcription_language_hints_strict)
        if strict and not hints:
            raise TranscriptionLanguageError("Strictには言語の選択が必要です")
        return (hints[0] if len(hints) == 1 else "auto"), {
            "language_hints": list(hints),
            "language_hints_strict": strict,
        }
    if len(hints) != 1:
        raise TranscriptionLanguageError("WhisperX / Azureでは言語を1つ選択してください")
    if provider == "azure_speech":
        if hints[0] not in AZURE_LOCALES:
            raise TranscriptionLanguageError("この言語のAzure認識ロケールは対応していません")
        return AZURE_LOCALES[hints[0]], {}
    return hints[0], {}
