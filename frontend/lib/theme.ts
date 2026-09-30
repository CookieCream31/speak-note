export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export const THEME_STORAGE_KEY = "speak-note.theme";

export function parseThemePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveTheme(
  preference: ThemePreference,
  systemDark: boolean,
): ResolvedTheme {
  return preference === "system" ? (systemDark ? "dark" : "light") : preference;
}

function applyTheme(preference: ThemePreference, systemDark: boolean) {
  const theme = resolveTheme(preference, systemDark);
  document.documentElement.dataset.theme = theme;
  document.documentElement.dataset.themePreference = preference;
  document.documentElement.style.colorScheme = theme;
  document
    .querySelector('meta[name="theme-color"]')
    ?.setAttribute("content", theme === "dark" ? "#09090b" : "#fafafa");
}

function readPreference(): ThemePreference {
  try {
    return parseThemePreference(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}

let preference: ThemePreference = "system";
let media: MediaQueryList | undefined;
const listeners = new Set<() => void>();

function notify() {
  applyTheme(preference, media?.matches ?? false);
  for (const listener of listeners) listener();
}

function onSystemChange() {
  if (preference === "system") notify();
}

function onStorage(event: StorageEvent) {
  if (event.key === THEME_STORAGE_KEY || event.key === null) {
    preference = readPreference();
    notify();
  }
}

export function subscribeTheme(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) {
    preference = readPreference();
    media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: dark)")
        : undefined;
    media?.addEventListener("change", onSystemChange);
    window.addEventListener("storage", onStorage);
    notify();
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      media?.removeEventListener("change", onSystemChange);
      window.removeEventListener("storage", onStorage);
      media = undefined;
    }
  };
}

export function getThemePreference() {
  return preference;
}
export function getServerThemePreference(): ThemePreference {
  return "system";
}

export function setThemePreference(value: ThemePreference) {
  preference = parseThemePreference(value);
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, preference);
  } catch {
    // A blocked/full store must not prevent changing the current page's theme.
  }
  notify();
}

// Runs in <head> before the body is painted; no request or React state update.
export const THEME_BOOTSTRAP_SCRIPT = `(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("${THEME_STORAGE_KEY}");
    if (saved === "light" || saved === "dark") preference = saved;
  } catch {}
  const systemDark = typeof matchMedia === "function" && matchMedia("(prefers-color-scheme: dark)").matches;
  const theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.themePreference = preference;
  root.style.colorScheme = theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", theme === "dark" ? "#09090b" : "#fafafa");
})();`;
