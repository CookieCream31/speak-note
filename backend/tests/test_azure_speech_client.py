from pathlib import Path

import httpx
import pytest

from app.services.transcription.azure import (
    AzureSpeechClient,
    AzureSpeechError,
    validate_azure_region,
)


def test_azure_speech_client_sends_pcm_wav_and_converts_detailed_result(
    tmp_path: Path,
) -> None:
    audio_path = tmp_path / "window.wav"
    audio_path.write_bytes(b"RIFF-pcm-data")

    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "japaneast.stt.speech.microsoft.com"
        assert request.url.path.endswith("/speech/recognition/conversation/cognitiveservices/v1")
        assert request.url.params["language"] == "ja-JP"
        assert request.url.params["format"] == "detailed"
        assert request.headers["ocp-apim-subscription-key"] == "azure-secret"
        assert request.headers["content-type"].startswith("audio/wav")
        assert request.read() == b"RIFF-pcm-data"
        return httpx.Response(
            200,
            json={
                "RecognitionStatus": "Success",
                "Offset": "10000000",
                "Duration": "20000000",
                "NBest": [
                    {
                        "Confidence": 0.91,
                        "Display": "こんにちは。",
                        "Words": [
                            {"Word": "こんにちは", "Offset": 10_000_000, "Duration": 15_000_000}
                        ],
                    }
                ],
            },
        )

    client = AzureSpeechClient(
        region="JapanEast",
        api_key="azure-secret",
        transport=httpx.MockTransport(handler),
    )
    assert client.supports_overlap_context is False
    result = client.transcribe(audio_path, "audio/wav")

    assert len(result.segments) == 1
    assert result.segments[0].text == "こんにちは。"
    assert result.segments[0].start == 1.0
    assert result.segments[0].end == 2.5
    assert result.segments[0].speaker == "SPEAKER_00"
    assert result.segments[0].words[0].word == "こんにちは"


def test_azure_speech_client_treats_no_match_as_silence(tmp_path: Path) -> None:
    audio_path = tmp_path / "silence.wav"
    audio_path.write_bytes(b"RIFF")
    client = AzureSpeechClient(
        region="eastus",
        api_key="secret",
        transport=httpx.MockTransport(
            lambda _request: httpx.Response(200, json={"RecognitionStatus": "NoMatch"})
        ),
    )

    assert client.transcribe(audio_path, "audio/wav").segments == []


def test_azure_speech_client_retries_temporary_errors(tmp_path: Path) -> None:
    audio_path = tmp_path / "window.wav"
    audio_path.write_bytes(b"RIFF")
    attempts = 0

    def handler(_request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            return httpx.Response(429, json={"error": "busy"})
        return httpx.Response(200, json={"RecognitionStatus": "NoMatch"})

    client = AzureSpeechClient(
        region="japaneast",
        api_key="secret",
        max_attempts=2,
        retry_delay_seconds=0,
        transport=httpx.MockTransport(handler),
    )

    assert client.transcribe(audio_path, "audio/wav").segments == []
    assert attempts == 2




def test_azure_speech_client_issues_short_lived_token() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        assert request.url.host == "japaneast.api.cognitive.microsoft.com"
        assert request.url.path == "/sts/v1.0/issueToken"
        assert request.headers["ocp-apim-subscription-key"] == "azure-secret"
        return httpx.Response(200, text="temporary-token")

    client = AzureSpeechClient(
        region="japaneast",
        api_key="azure-secret",
        transport=httpx.MockTransport(handler),
    )

    assert client.issue_token() == "temporary-token"
def test_azure_region_rejects_hosts_and_urls() -> None:
    with pytest.raises(AzureSpeechError):
        validate_azure_region("https://example.com")
