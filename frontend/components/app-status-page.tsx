import Link from "next/link";
import type { ReactNode } from "react";
import { ThemeSelector } from "./theme-selector";
import styles from "./app-status-page.module.css";

export function AppStatusPage({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <p className={styles.brand}>speak-note</p>
        <h1>{title}</h1>
        <p>{description}</p>
        <div className={styles.actions}>
          {children}
          <Link href="/">ホームへ戻る</Link>
        </div>
        <ThemeSelector />
      </section>
    </main>
  );
}
