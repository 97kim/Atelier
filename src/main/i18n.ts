// main 프로세스의 번역 인스턴스. 메뉴·macOS 알림처럼 main 이 직접 그리는 문구에 쓴다.
// 대화 기록에 남는 문구는 여기서 번역하지 않는다 — 코드와 값만 남기고 renderer 가 표시할 때 번역한다.

import type { i18n } from "i18next";
import { createI18n, type Locale } from "@shared/i18n";

let instance: i18n | null = null;

/** 처음 부르면 만들고, 이후에는 언어만 바꾼다. */
export function setMainLocale(locale: Locale): void {
  if (!instance) instance = createI18n(locale);
  else if (instance.language !== locale) void instance.changeLanguage(locale);
}

export function mainI18n(): i18n {
  if (!instance) instance = createI18n("ko");
  return instance;
}
