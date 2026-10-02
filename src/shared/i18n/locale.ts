// 표시 언어. 설정에 저장하는 값(LanguageSetting)과 실제로 쓰는 값(Locale)을 나눈다 —
// "system" 은 macOS 의 선호 언어를 따라가고, 그 해석은 main 이 해서 renderer 에 알려 준다.

export type Locale = "ko" | "en";
export type LanguageSetting = "system" | Locale;

export const LOCALES: readonly Locale[] = ["ko", "en"];
export const LANGUAGE_SETTINGS: readonly LanguageSetting[] = ["system", "ko", "en"];
export const LANGUAGE_SETTING_DEFAULT: LanguageSetting = "system";

export function isLanguageSetting(v: unknown): v is LanguageSetting {
  return v === "system" || v === "ko" || v === "en";
}

/**
 * 설정값을 실제 언어로. "system" 이면 시스템이 가장 선호하는 언어(app.getPreferredSystemLanguages()[0])가
 * 한국어일 때만 ko, 그 밖(목록이 비었을 때 포함)은 en.
 */
export function resolveLocale(setting: LanguageSetting, systemLanguages: readonly string[]): Locale {
  if (setting !== "system") return setting;
  const first = (systemLanguages[0] ?? "").toLowerCase();
  return first === "ko" || first.startsWith("ko-") ? "ko" : "en";
}

/** 날짜·숫자 표시에 쓰는 Intl 로케일 태그. 계산용 규약(cron 의 en-US 요일 파싱 등)에는 쓰지 않는다. */
export function intlLocale(locale: Locale): string {
  return locale === "ko" ? "ko-KR" : "en-US";
}
