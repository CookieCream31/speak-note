from pathlib import Path

import httpx
import pytest

from app.services.transcription.client import (
    WhisperXClient,
    WhisperXEmptyAudioError,
    WhisperXError,
)


def test_whisperx_client_sends_required_multipart_fields_and_bearer(tmp_path: Path) -> None:
    audio_path = tmp_path / "audio.mp3"
    audio_path.write_bytes(b"ID3")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.path == "/v1/audio/transcriptions"
        assert request.headers["authorization"] == "Bearer secret-token"
        content_type = request.headers["content-type"]
        assert content_type.startswith("multipart/form-data; boundary=")
        body = request.read()
        for expected in (
            b'name="model"',
            b"large-v3",
            b'name="language"',
            b"ja",
            b'name="align"',
            b'name="diarize"',
            b'name="response_format"',
            b"verbose_json",
            b'name="min_speakers"',
            b'name="max_speakers"',
            b'filename="audio.mp3"',
        ):
            assert expected in body
        return httpx.Response(
            200,
            json={
                "segments": {
                    "segments": [
                        {"start": 0.1, "end": 1.25, "text": "こんにちは", "speaker": "SPEAKER_00"}
                    ]
                }
            },
        )

    client = WhisperXClient(
        "http://whisperx.test",
        "secret-token",
        transport=httpx.MockTransport(handler),
    )
    result = client.transcribe(
        audio_path,
        "audio/mpeg",
        min_speakers=2,
        max_speakers=4,
    )

    assert len(result.segments) == 1
    assert result.segments[0].speaker == "SPEAKER_00"


def test_whisperx_client_retries_connection_errors(tmp_path: Path) -> None:
    audio_path = tmp_path / "audio.wav"
    audio_path.write_bytes(b"RIFF")
    attempts = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts < 3:
            raise httpx.ConnectError("temporarily unavailable", request=request)
        body = request.read()
        assert b'name="min_speakers"' not in body
        assert b'name="max_speakers"' not in body
        return httpx.Response(
            200,
            json={
                "segments": [
                    {
                        "start": 0.0,
                        "end": 1.0,
                        "text": "再試行成功",
                        "speaker": "SPEAKER_00",
                    }
                ]
            },
        )

    client = WhisperXClient(
        "http://whisperx.test",
        "",
        max_attempts=3,
        retry_delay_seconds=0,
        transport=httpx.MockTransport(handler),
    )

    result = client.transcribe(audio_path, "audio/wav")

    assert attempts == 3
    assert result.segments[0].text == "再試行成功"


@pytest.mark.parametrize(
    ("status_code", "detail"),
    [
        (422, "Decoded audio is empty (no audio stream or zero-length input)."),
        (429, "Too many requests"),
        (503, "Model is temporarily unavailable"),
    ],
)
def test_whisperx_client_retries_temporary_http_errors(
    tmp_path: Path,
    status_code: int,
    detail: str,
) -> None:
    audio_path = tmp_path / "audio.wav"
    audio_path.write_bytes(b"RIFF")
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(status_code, json={"detail": detail})
        return httpx.Response(200, json={"segments": []})

    client = WhisperXClient(
        "http://whisperx.test",
        "",
        max_attempts=2,
        retry_delay_seconds=0,
        transport=httpx.MockTransport(handler),
    )

    assert client.transcribe(audio_path, "audio/wav").segments == []
    assert attempts == 2


def test_whisperx_client_classifies_persistent_empty_audio(
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "empty.wav"
    audio_path.write_bytes(b"RIFF")
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(
            422,
            json={"detail": "Decoded audio is empty (no audio stream or zero-length input)."},
        )

    client = WhisperXClient(
        "http://whisperx.test",
        "",
        max_attempts=2,
        retry_delay_seconds=0,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(WhisperXEmptyAudioError, match="Decoded audio is empty"):
        client.transcribe(audio_path, "audio/wav")
    assert attempts == 2


def test_whisperx_client_does_not_retry_validation_error_and_keeps_detail(
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "audio.wav"
    audio_path.write_bytes(b"RIFF")
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        return httpx.Response(422, json={"detail": "min_speakers must be <= max_speakers"})

    client = WhisperXClient(
        "http://whisperx.test",
        "",
        max_attempts=3,
        retry_delay_seconds=0,
        transport=httpx.MockTransport(handler),
    )

    with pytest.raises(WhisperXError, match="min_speakers must be <= max_speakers"):
        client.transcribe(audio_path, "audio/wav")
    assert attempts == 1
