"use client";

import { useEffect } from "react";
import { subscribeTheme } from "@/lib/theme";

/** Keep OS and other-tab changes active on pages without the settings control. */
export function ThemeObserver() {
  useEffect(() => subscribeTheme(() => {}), []);
  return null;
}
