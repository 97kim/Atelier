// 도구 카드의 상태. 화면에 보이는 문구("완료"·"권한 대기")와 따로 둔다 —
// 색·아이콘·타이머는 이 값으로 정하고, 문구는 사전(toolCard.state.*)에서 가져온다.

import type { ToolBlock } from "./session-state";

/** Codex 의 추가 권한 요청에 붙는 도구 이름. 기록과 교차 리뷰 판정이 이 값에 기대므로 바꾸지 않고, 화면에는 번역해서 보인다. */
// i18n-ignore: 도구 식별자(예전 기록과 같은 이름)
export const CODEX_PERMISSION_TOOL = "권한";

export type ToolState = "partial" | "waiting_permission" | "waiting_answer" | "denied" | "skipped" | "failed" | "done" | "running";

export function toolState(block: Pick<ToolBlock, "name" | "partial" | "result" | "permission">): ToolState {
  // 입력을 만들다 턴이 끝난 도구는 partial 인 채로 결과(오류)가 붙는다 — 그때는 실패로
  if (block.partial && !block.result) return "partial";
  const question = block.name === "AskUserQuestion";
  if (block.permission === "pending") return question ? "waiting_answer" : "waiting_permission";
  if (block.permission === "denied") return question ? "skipped" : "denied";
  if (block.result) return block.result.isError ? "failed" : "done";
  return "running";
}

export const isToolWaiting = (s: ToolState): boolean => s === "waiting_permission" || s === "waiting_answer";
/** 진행 중(입력 생성·실행·대기) — 라벨에 shimmer 를 흘리고 경과 시간을 센다. */
export const isToolActive = (s: ToolState): boolean => s === "partial" || s === "running" || isToolWaiting(s);
export const isToolFailed = (s: ToolState): boolean => s === "failed" || s === "denied";
