from dataclasses import dataclass

from app.models.realtime import RealtimeChunk


@dataclass(frozen=True)
class RealtimeTranscriptionWindow:
    start_ms: int
    end_ms: int
    commit_start_ms: int


def build_realtime_transcription_windows(
    chunk: RealtimeChunk,
    *,
    window_ms: int,
    step_ms: int,
) -> list[RealtimeTranscriptionWindow]:
    """Split a delayed MediaRecorder chunk without leaving timeline gaps."""
    effective_window_ms = max(1, window_ms)
    effective_step_ms = max(1, min(step_ms, effective_window_ms))
    # Rows created before delayed-chunk support only retained the final window
    # here. start_ms remains authoritative for the beginning of new audio.
    earliest_window_start_ms = min(chunk.window_start_ms, chunk.start_ms)
    if chunk.end_ms - chunk.start_ms <= effective_window_ms:
        return [
            RealtimeTranscriptionWindow(
                start_ms=earliest_window_start_ms,
                end_ms=chunk.end_ms,
                commit_start_ms=chunk.start_ms,
            )
        ]

    first_end_ms = min(chunk.end_ms, chunk.start_ms + effective_window_ms)
    windows = [
        RealtimeTranscriptionWindow(
            start_ms=max(earliest_window_start_ms, first_end_ms - effective_window_ms),
            end_ms=first_end_ms,
            commit_start_ms=chunk.start_ms,
        )
    ]
    commit_start_ms = first_end_ms
    while commit_start_ms < chunk.end_ms:
        end_ms = min(chunk.end_ms, commit_start_ms + effective_step_ms)
        windows.append(
            RealtimeTranscriptionWindow(
                start_ms=max(earliest_window_start_ms, end_ms - effective_window_ms),
                end_ms=end_ms,
                commit_start_ms=commit_start_ms,
            )
        )
        commit_start_ms = end_ms
    return windows
