// main 프로세스의 번역 인스턴스. 메뉴·macOS 알림처럼 main 이 직접 그리는 문구에 쓴다.
// 대화 기록에 남는 문구는 여기서 번역하지 않는다 — 코드와 값만 남기고 renderer 가 표시할 때 번역한다.

import type { i18n } from "i18next";
import { createI18n, type Locale } from "@shared/i18n";
import type { Msg, MsgKey } from "@shared/i18n/msg";

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

/** main 이 그 자리에서 번역하는 문구(메뉴·알림·바로 보이고 사라지는 오류). `mt("main.menu.file")` */
export const mt = ((...args: unknown[]) => (mainI18n().t as unknown as (...a: unknown[]) => string)(...args)) as unknown as i18n["t"];

/**
 * 저장되는 문구(대화 기록의 오류·안내 등). 지금 언어의 문장과 사전 키를 함께 돌려준다 — 이벤트에 펼쳐 넣는다:
 * `record(s, { type: "error", ts, fatal: false, ...appMsg("session.msg.interrupted") })`
 */
export function appMsg(key: MsgKey, params?: Msg["params"]): { message: string; msg: Msg } {
  return { message: (mainI18n().t as unknown as (k: string, p?: object) => string)(key, params), msg: params ? { key, params } : { key } };
}

/**
 * 앱이 만든 오류. 던진 뒤 대화 기록의 오류로 저장될 수 있는 것에 쓴다 — 받는 쪽이 msg 를 함께 저장해
 * 나중에 지금 언어로 다시 그릴 수 있다. 외부(provider·OS) 오류는 그대로 Error 로 둔다.
 */
export class MsgError extends Error {
  readonly msg: Msg;
  constructor(key: MsgKey, params?: Msg["params"]) {
    const m = appMsg(key, params);
    super(m.message);
    this.name = "MsgError";
    this.msg = m.msg;
  }
}
