import { ChevronRight } from "lucide-react";
import Link from "next/link";

import { AppSidebar } from "@/components/app-sidebar";
import { MeetingTemplateManager } from "@/components/meeting-template-manager";
import { ThemeSelector } from "@/components/theme-selector";
import type { MeetingTemplate } from "@/lib/api";

import styles from "./page.module.css";

export const dynamic = "force-dynamic";

const backendInternalUrl = process.env.BACKEND_INTERNAL_URL ?? "http://backend:8001";

async function loadTemplates(): Promise<MeetingTemplate[]> {
  const response = await fetch(`${backendInternalUrl}/api/v1/meeting-templates`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Backend returned ${response.status}`);
  return await response.json() as MeetingTemplate[];
}

/** Dedicated editor for meeting templates; AI settings only links here. */
export default async function MeetingTemplatesPage() {
  const templates = await loadTemplates();
  return (
    <div className={styles.shell}>
      <AppSidebar current="settings" />
      <main className={styles.main}>
        <header className={styles.header}>
          <nav className={styles.breadcrumb} aria-label="パンくずリスト">
            <Link href="/settings/ai">AI設定</Link>
            <ChevronRight size={14} aria-hidden="true" />
            <h1>議事録テンプレート</h1>
          </nav>
          <ThemeSelector />
        </header>
        <div className={styles.content}>
          <MeetingTemplateManager initialTemplates={templates} />
        </div>
      </main>
    </div>
  );
}
