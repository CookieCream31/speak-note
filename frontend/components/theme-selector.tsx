"use client";

import { Monitor, Moon, Sun } from "lucide-react";
import { type ReactNode, useSyncExternalStore } from "react";
import {
  getServerThemePreference,
  getThemePreference,
  setThemePreference,
  subscribeTheme,
  type ThemePreference,
} from "@/lib/theme";
import styles from "./theme-selector.module.css";

const THEME_OPTIONS: { value: ThemePreference; label: string; icon: ReactNode }[] = [
  { value: "system", label: "システムに合わせる", icon: <Monitor size={15} /> },
  { value: "light", label: "ライト", icon: <Sun size={15} /> },
  { value: "dark", label: "ダーク", icon: <Moon size={15} /> },
];

export function ThemeSelector() {
  const preference = useSyncExternalStore(
    subscribeTheme,
    getThemePreference,
    getServerThemePreference,
  );
  return (
    <div className={styles.control} role="group" aria-label="表示テーマ">
      {THEME_OPTIONS.map((option) => (
        <button
          type="button"
          key={option.value}
          data-theme-option={option.value}
          aria-label={option.label}
          title={option.label}
          aria-pressed={preference === option.value}
          onClick={() => setThemePreference(option.value)}
        >
          {option.icon}
        </button>
      ))}
    </div>
  );
}
