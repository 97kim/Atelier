// i18next 인스턴스 만들기. main 과 renderer 가 각자 하나씩 만들어 같은 사전을 쓴다.
// 사전을 번들에 넣었으므로 초기화는 동기로 끝난다(백엔드 로딩 없음).

import i18next, { type i18n, type Module, type NewableModule } from "i18next";
import { en } from "./en";
import { ko } from "./ko";
import type { Locale } from "./locale";

export type { Dictionary } from "./ko";
export * from "./locale";

export const resources = {
  ko: { translation: ko },
  en: { translation: en },
} as const;

/** plugins 는 renderer 가 react-i18next 의 initReactI18next 를 붙일 때 쓴다. */
export function createI18n(locale: Locale, plugins: (Module | NewableModule<Module>)[] = []): i18n {
  const instance = i18next.createInstance();
  for (const p of plugins) instance.use(p);
  void instance.init({
    resources,
    lng: locale,
    fallbackLng: "ko",
    supportedLngs: ["ko", "en"],
    defaultNS: "translation",
    initAsync: false,
    returnEmptyString: false,
    returnNull: false,
    // React 가 이스케이프한다. main 은 문자열을 HTML 로 쓰지 않는다.
    interpolation: { escapeValue: false },
  });
  return instance;
}
