// 도구 카드의 상태. 화면에 보이는 문구("완료"·"권한 대기")와 따로 둔다 —
// 색·아이콘·타이머는 이 값으로 정하고, 문구는 사전(toolCard.state.*)에서 가져온다.

import type { ToolBlock } from "./session-state";

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
