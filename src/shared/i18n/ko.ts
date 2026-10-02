// 한국어 사전(원본). 영역마다 파일을 나눈다(ko/*.ts) — 키는 의미 이름으로, 문구가 바뀌어도 키는 그대로 둔다.
// 화면 문구는 차례로 옮기는 중이다. 여기 없는 문구는 아직 코드에 직접 있다.

import { chat } from "./ko/chat";
import { cli } from "./ko/cli";
import { common } from "./ko/common";
import { fanout } from "./ko/fanout";
import { main } from "./ko/main";
import { nav } from "./ko/nav";
import { orchestration } from "./ko/orchestration";
import { panel } from "./ko/panel";
import { repo } from "./ko/repo";
import { schedules } from "./ko/schedules";
import { session } from "./ko/session";
import { settings } from "./ko/settings";
import { shared } from "./ko/shared";
import { toolCard } from "./ko/toolCard";
import { usage } from "./ko/usage";

export const ko = { chat, cli, common, fanout, main, nav, orchestration, panel, repo, schedules, session, settings, shared, toolCard, usage };

/** 사전의 모양. 값은 모두 문자열이다. */
export type Dictionary = typeof ko;
