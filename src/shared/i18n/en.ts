// 영어 사전. 한국어 사전과 같은 모양이되 빠진 키를 허용한다 — 없는 키는 한국어로 보인다(fallbackLng).
// 빈 문자열("")은 넣지 않는다: i18next 는 빈 값을 번역이 있는 것으로 본다.

import type { Dictionary } from "./ko";

type DeepPartial<T> = { [K in keyof T]?: T[K] extends string ? string : DeepPartial<T[K]> };

export const en: DeepPartial<Dictionary> = {
  toolCard: {
    state: {
      partial: "Preparing input",
      waiting_permission: "Awaiting permission",
      waiting_answer: "Awaiting answer",
      denied: "Denied",
      skipped: "Skipped",
      failed: "Failed",
      done: "Done",
      running: "Running",
    },
  },
};
