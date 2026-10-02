// 저장됐다가 나중에 다시 그려지는 앱 문구(대화 기록의 오류·안내, 예약 실행 사유 등)의 규약.
// 만든 시점의 문장(message 등)과 함께 사전 키·값을 남기고, 그릴 때 지금 언어로 번역한다.
// 키는 사전의 `<영역>.msg.*` 만 쓴다. 한 번 내보낸 키와 값 이름은 저장 데이터의 일부이므로 바꾸지 않는다
// (문구는 고쳐도 된다). 모르는 키는 함께 저장한 문장으로 보인다.

import type { ParseKeys } from "i18next";

export type MsgKey = Extract<ParseKeys, `${string}.msg.${string}`>;

export interface Msg {
  key: MsgKey;
  params?: Record<string, string | number>;
}

/** t 와 exists 만 쓴다 — main 의 인스턴스와 renderer 의 useTranslation().i18n 을 모두 받는다. */
interface Translator {
  t: (key: never, params?: never) => string;
  exists: (key: string, params?: object) => boolean;
}

/**
 * 저장된 Msg 를 지금 언어의 문장으로. Msg 가 없거나(예전 기록·외부 오류) 모르는 키면 fallback(함께 저장한 문장)을 쓴다.
 * 기록은 디스크에서 읽은 값이라 모양을 믿지 않는다.
 */
export function msgText(i18n: unknown, msg: Msg | undefined | null, fallback: string): string {
  const tr = i18n as Translator;
  const key: unknown = msg?.key;
  if (typeof key !== "string" || !key.includes(".msg.")) return fallback;
  const params = msg?.params;
  const safe = params && typeof params === "object" && !Array.isArray(params) ? params : undefined;
  // 복수형 키(_one/_other)는 count 를 함께 줘야 찾는다
  if (!tr.exists(key, safe)) return fallback;
  return tr.t(key as never, safe as never);
}
