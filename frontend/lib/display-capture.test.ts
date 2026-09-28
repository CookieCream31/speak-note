import { describe, expect, it } from "vitest";

import {
  displayCaptureSupportMessage,
  evaluateDisplayCaptureSupport,
  microphoneCaptureSupportMessage,
} from "./display-capture";

describe("display capture support", () => {
  it("accepts a secure browser with capture and recording APIs", () => {
    expect(evaluateDisplayCaptureSupport({
      isSecureContext: true,
      hasGetDisplayMedia: true,
      hasMediaRecorder: true,
    })).toBe("supported");
  });

  it("distinguishes insecure origins from unsupported browsers", () => {
    expect(evaluateDisplayCaptureSupport({
      isSecureContext: false,
      hasGetDisplayMedia: true,
      hasMediaRecorder: true,
    })).toBe("insecure");
    expect(evaluateDisplayCaptureSupport({
      isSecureContext: true,
      hasGetDisplayMedia: false,
      hasMediaRecorder: true,
    })).toBe("unsupported");
  });

  it("provides an actionable fallback for unsupported mobile browsers", () => {
    expect(displayCaptureSupportMessage("unsupported")).toContain("アップロード");
    expect(displayCaptureSupportMessage("insecure")).toContain("HTTPS");
    expect(microphoneCaptureSupportMessage("unsupported")).toContain("マイク録音");
    expect(microphoneCaptureSupportMessage("insecure")).toContain("HTTPS");
  });
});
