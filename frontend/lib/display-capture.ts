export type DisplayCaptureSupport = "supported" | "insecure" | "unsupported";

export interface DisplayCaptureEnvironment {
  isSecureContext: boolean;
  hasGetDisplayMedia: boolean;
  hasMediaRecorder: boolean;
}

export function evaluateDisplayCaptureSupport(
  environment: DisplayCaptureEnvironment,
): DisplayCaptureSupport {
  if (!environment.isSecureContext) return "insecure";
  if (!environment.hasGetDisplayMedia || !environment.hasMediaRecorder) {
    return "unsupported";
  }
  return "supported";
}

export function detectDisplayCaptureSupport(): DisplayCaptureSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unsupported";
  }
  return evaluateDisplayCaptureSupport({
    isSecureContext: window.isSecureContext,
    hasGetDisplayMedia: typeof navigator.mediaDevices?.getDisplayMedia === "function",
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
  });
}

export function displayCaptureSupportMessage(
  support: Exclude<DisplayCaptureSupport, "supported">,
): string {
  if (support === "insecure") {
    return "画面共有録画にはHTTPS接続が必要です。HTTPSで開き直してください。";
  }
  return "この端末またはブラウザは、Web画面共有録画に対応していません。端末の画面収録を保存し、音声・動画ファイルとしてアップロードしてください。";
}

export function detectMicrophoneCaptureSupport(): DisplayCaptureSupport {
  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return "unsupported";
  }
  return evaluateDisplayCaptureSupport({
    isSecureContext: window.isSecureContext,
    hasGetDisplayMedia: typeof navigator.mediaDevices?.getUserMedia === "function",
    hasMediaRecorder: typeof MediaRecorder !== "undefined",
  });
}

export function microphoneCaptureSupportMessage(
  support: Exclude<DisplayCaptureSupport, "supported">,
): string {
  if (support === "insecure") {
    return "マイク録音にはHTTPS接続が必要です。HTTPSで開き直してください。";
  }
  return "この端末またはブラウザはマイク録音に対応していません。録音ファイルを音声・動画ファイルとしてアップロードしてください。";
}
