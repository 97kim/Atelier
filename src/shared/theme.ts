// 화면 테마. "system" 은 macOS 화면 모드(prefers-color-scheme)를 따른다.
export type ThemeMode = "system" | "light" | "dark";
export const THEME_MODES: readonly ThemeMode[] = ["system", "light", "dark"];
export function isThemeMode(v: unknown): v is ThemeMode {
  return v === "system" || v === "light" || v === "dark";
}
/** 실제로 칠할 테마. system 이면 시스템이 어두운지에 따라. */
export function resolveTheme(mode: ThemeMode, systemDark: boolean): "light" | "dark" {
  return mode === "system" ? (systemDark ? "dark" : "light") : mode;
}
