"use client";

import { AppStatusPage } from "@/components/app-status-page";

export default function ErrorPage({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <AppStatusPage
      title="ページを表示できませんでした"
      description="しばらく待ってから再試行してください。続く場合はBackendの状態を確認してください。"
    >
      <button type="button" onClick={reset}>
        再試行
      </button>
    </AppStatusPage>
  );
}
