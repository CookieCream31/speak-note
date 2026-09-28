"use client";

import { AppStatusPage } from "@/components/app-status-page";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";
import "./theme.css";
import "./globals.css";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ja" suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#f6f7f9" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>
        <AppStatusPage
          title="画面を表示できませんでした"
          description="しばらく待ってから再試行してください。"
        >
          <button type="button" onClick={reset}>
            再試行
          </button>
        </AppStatusPage>
      </body>
    </html>
  );
}
