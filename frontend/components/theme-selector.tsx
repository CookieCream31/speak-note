"use client";

import { useId, useSyncExternalStore } from "react";
import {
  getServerThemePreference,
  getThemePreference,
  parseThemePreference,
  setThemePreference,
  subscribeTheme,
} from "@/lib/theme";
import styles from "./theme-selector.module.css";

export function ThemeSelector() {
  const id = useId();
  const preference = useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    getServerThemePreference,
  );
  return (
    <label className={styles.control} htmlFor={id}>
      <span>表示テーマ</span>
      <select
        id={id}
        aria-label="表示テーマ"
        value={preference}
        onChange={(event) =>
          setThemePreference(parseThemePreference(event.target.value))
        }
      >
        <option value="system">システムに合わせる</option>
        <option value="light">ライト</option>
        <option value="dark">ダーク</option>
      </select>
    </label>
  );
}
