// 영어 사전. 한국어 사전과 같은 모양이되 빠진 키를 허용한다 — 없는 키는 한국어로 보인다(fallbackLng).
// 빈 문자열("")은 넣지 않는다: i18next 는 빈 값을 번역이 있는 것으로 본다.

import { chat } from "./en/chat";
import { common } from "./en/common";
import { fanout } from "./en/fanout";
import { nav } from "./en/nav";
import { orchestration } from "./en/orchestration";
import { panel } from "./en/panel";
import { schedules } from "./en/schedules";
import { settings } from "./en/settings";
import { shared } from "./en/shared";
import { toolCard } from "./en/toolCard";
import { usage } from "./en/usage";
import type { Dictionary } from "./ko";
import type { DeepPartial } from "./types";

export const en: DeepPartial<Dictionary> = { chat, common, fanout, nav, orchestration, panel, schedules, settings, shared, toolCard, usage };
