import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Noto_Sans_JP } from "next/font/google";
import type { ReactNode } from "react";

import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme";

import "./theme.css";
import "./globals.css";

const geist = Geist({ subsets: ["latin"], variable: "--font-geist", display: "swap" });
const geistMono = Geist_Mono({ subsets: ["latin"], variable: "--font-geist-mono", display: "swap" });
// Japanese glyphs are large, so let the browser fetch only the subsets a page uses.
const notoSansJp = Noto_Sans_JP({ subsets: ["latin"], variable: "--font-noto-sans-jp", display: "swap", preload: false });

export const metadata: Metadata = {
  title: "speak-note",
  description: "会議を、確かな次の一歩へ。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="ja" className={`${geist.variable} ${geistMono.variable} ${notoSansJp.variable}`} suppressHydrationWarning>
      <head>
        <meta name="theme-color" content="#fafafa" />
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} />
      </head>
      <body>{children}</body>
    </html>
  );
}

