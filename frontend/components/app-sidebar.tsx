import { Folder, House, Sparkles } from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";

import styles from "./app-sidebar.module.css";

type Section = "meetings" | "projects" | "settings";

const items: { section: Section; href: string; label: string; icon: ReactNode }[] = [
  { section: "meetings", href: "/", label: "すべての会議", icon: <House size={18} aria-hidden="true" /> },
  { section: "projects", href: "/projects", label: "プロジェクト", icon: <Folder size={18} aria-hidden="true" /> },
  { section: "settings", href: "/settings/ai", label: "AI設定", icon: <Sparkles size={18} aria-hidden="true" /> },
];

/** Navigation sidebar for pages other than home (home keeps its own sidebar with counts and tags). */
export function AppSidebar({ current }: { current: Section }) {
  return (
    <aside className={styles.sidebar}>
      <Link className={styles.brand} href="/" aria-label="speak-note ホーム">
        <span className={styles.brandMark} aria-hidden="true"><i /><i /><i /></span>
        <span>speak-note</span>
      </Link>
      <nav className={styles.navigation} aria-label="メインナビゲーション">
        {items.map((item) => (
          <Link
            key={item.section}
            href={item.href}
            className={item.section === current ? styles.active : undefined}
            aria-current={item.section === current ? "page" : undefined}
          >
            {item.icon}
            <span>{item.label}</span>
          </Link>
        ))}
      </nav>
      <div className={styles.status}>
        <strong>Ubuntu Server</strong>
        <small>ローカル ワークスペース · Private</small>
      </div>
    </aside>
  );
}
