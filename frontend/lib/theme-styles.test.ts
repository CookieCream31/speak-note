import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(__dirname, "..");
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
const palettePath = resolve(root, "app/theme.css");
const palette = readFileSync(palettePath, "utf8");
const styles = [
  ...files(resolve(root, "app")),
  ...files(resolve(root, "components")),
].filter((path) => path.endsWith(".css") && path !== palettePath);
const light = Object.fromEntries(
  [
    ...palette
      .split(':root[data-theme="dark"]')[0]
      .matchAll(/--([\w-]+):\s*([^;]+);/g),
  ].map((m) => [m[1], m[2]]),
);
const dark = {
  ...light,
  ...Object.fromEntries(
    [
      ...palette
        .split(':root[data-theme="dark"]')[1]
        .split("@media")[0]
        .matchAll(/--([\w-]+):\s*([^;]+);/g),
    ].map((m) => [m[1], m[2]]),
  ),
};
function luminance(value: string): number {
  const channels = [1, 3, 5]
    .map(
      (position) =>
        Number.parseInt(value.slice(position, position + 2), 16) / 255,
    )
    .map((channel) =>
      channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4,
    );
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}
function contrast(first: string, second: string): number {
  const a = luminance(first),
    b = luminance(second);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe("application theme coverage", () => {
  it("keeps literal colors and local palette overrides out of every component and page stylesheet", () => {
    for (const path of styles) {
      const css = readFileSync(path, "utf8");
      const declarations = [...css.matchAll(/[\w-]+:([^;{}]+)/g)]
        .map((match) => match[1])
        .join(";");
      expect(declarations, path).not.toMatch(
        /#[\da-fA-F]{3,8}\b|rgba?\(|(?<![\w-])(?:white|black)(?![\w-])/,
      );
      expect(css, path).not.toMatch(
        /--(?:ink|paper|surface|panel|muted|blue|accent|mint|line)\s*:/,
      );
      for (const match of css.matchAll(/var\(--([\w-]+)/g)) {
        if (
          /^(?:player-video-height|video-aspect|settings-width|meeting-header-height)$/.test(
            match[1],
          )
        )
          continue;
        expect(light, `${path}: ${match[1]}`).toHaveProperty(match[1]);
      }
    }
  });
  it("keeps literal colors out of inline styles and public runtime assets", () => {
    const sources = ["app", "components", "lib", "public"]
      .flatMap((directory) => files(resolve(root, directory)))
      .filter(
        (path) => /\.(?:ts|tsx|js)$/.test(path) && !path.includes(".test."),
      );
    for (const path of sources) {
      const allowed =
        path === resolve(root, "lib/theme.ts")
          ? ["#11151c", "#f6f7f9"]
          : [
                resolve(root, "app/layout.tsx"),
                resolve(root, "app/global-error.tsx"),
              ].includes(path)
            ? ["#f6f7f9"]
            : [];
      for (const match of readFileSync(path, "utf8").matchAll(
        /#[\da-fA-F]{3,8}\b|rgba?\([^)]*\)/g,
      )) {
        expect(allowed, `${path}: ${match[0]}`).toContain(match[0]);
      }
    }
  });
  it("defines all application colors for both explicit dark mode and the no-JS OS fallback", () => {
    const explicit = palette
      .split(':root[data-theme="dark"]')[1]
      .split("@media")[0];
    const fallback = palette.split("@media (prefers-color-scheme: dark)")[1];
    const definitions = (css: string) =>
      Object.fromEntries(
        [...css.matchAll(/--([\w-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2]]),
      );
    expect(definitions(fallback)).toEqual(definitions(explicit));
    for (const key of Object.keys(light).filter(
      (key) => !key.startsWith("media-") && key !== "purple-solid",
    )) {
      expect(definitions(explicit)).toHaveProperty(key);
    }
    expect(fallback).toContain(':root:not([data-theme="light"])');
  });
  it.each([
    ["light", light],
    ["dark", dark],
  ] as const)(
    "keeps readable foreground/background pairs in %s mode",
    (_, values) => {
      for (const surface of [
        "paper",
        "surface",
        "panel",
        "surface-hover",
        "blue-soft",
      ]) {
        for (const text of [
          "ink",
          "muted",
          "text-secondary",
          "text-subtle",
          "blue",
        ]) {
          expect(
            contrast(values[text], values[surface]),
            `${text}/${surface}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
      for (const semantic of ["success", "danger", "warning"]) {
        expect(
          contrast(values[semantic], values[`${semantic}-soft`]),
          semantic,
        ).toBeGreaterThanOrEqual(4.5);
      }
      for (const background of [
        "primary-bg",
        "primary-hover",
        "danger-solid",
        "danger-hover",
        "success-solid",
        "purple-solid",
      ]) {
        expect(
          contrast(values["on-primary"], values[background]),
          background,
        ).toBeGreaterThanOrEqual(4.5);
      }
      expect(
        contrast(values["control-border"], values.panel),
      ).toBeGreaterThanOrEqual(3);
      // Also check actual rules that explicitly set both colors, including errors and badges.
      for (const path of styles) {
        for (const rule of readFileSync(path, "utf8").matchAll(
          /([^{}]+)\{([^{}]*)\}/g,
        )) {
          const foreground = rule[2].match(
            /(?<![\w-])color:\s*var\(--([\w-]+)\)/,
          );
          const background = rule[2].match(
            /(?<![\w-])background(?:-color)?:\s*var\(--([\w-]+)\)/,
          );
          if (!foreground || !background) continue;
          const fg = values[foreground[1]],
            bg = values[background[1]];
          if (!/^#[\da-f]{6}$/i.test(fg) || !/^#[\da-f]{6}$/i.test(bg))
            continue;
          expect(
            contrast(fg, bg),
            `${path} ${rule[1].trim()}`,
          ).toBeGreaterThanOrEqual(4.5);
        }
      }
    },
  );
  it("makes the theme selector available on all four page types", () => {
    for (const path of [
      "components/meetings-manager.tsx",
      "components/ai-settings-manager.tsx",
      "components/project-manager.tsx",
      "app/meetings/[meeting_id]/page.tsx",
    ]) {
      expect(readFileSync(resolve(root, path), "utf8"), path).toContain(
        "<ThemeSelector />",
      );
    }
  });
});
