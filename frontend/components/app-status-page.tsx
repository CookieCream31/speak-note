import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeSelector } from "./theme-selector";
import styles from "./app-status-page.module.css";

export function AppStatusPage({
  code,
  title,
  description,
  children,
}: {
  /** Short label above the title, such as "404". */
  code?: string;
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <section className={styles.content}>
        {code && <span className={styles.code}>{code}</span>}
        <h1>{title}</h1>
        <p>{description}</p>
        <div className={styles.actions} data-has-retry={Boolean(children)}>
          <Link href="/">ホームへ戻る</Link>
          {children}
        </div>
        <span className={styles.brand}>speak-note</span>
      </section>
      {/* Placed after the content so focus reaches the page actions first; positioned top-right by CSS. */}
      <div className={styles.theme}><ThemeSelector /></div>
    </main>
  );
}
