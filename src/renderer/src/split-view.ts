// 채팅 화면 분할: 좌우 두 칸에 각각 다른 탭. 규칙은 여기 한 곳에 모은다(여러 effect 로 나눠 맞추면 순서에 따라 어긋난다).
// 모델의 activeTabId 는 "포커스된 칸의 탭" 이다 — 단축키·⌘W·사이드바 강조가 지금처럼 활성 탭 하나를 보면 된다.

import { kvGet, kvSet } from "./kv-store";

export interface SplitState {
  left: string;
  right: string;
  /** 포커스된 칸. 0 = 왼쪽, 1 = 오른쪽. */
  focused: 0 | 1;
}

/** "오른쪽에 나란히 열기": 지금 보던 탭은 왼쪽, 고른 탭은 오른쪽에 두고 오른쪽에 포커스. 같은 탭이면 그대로. */
export function openSplit(state: SplitState | null, activeId: string | null, tabId: string): SplitState | null {
  if (!activeId || tabId === activeId) return state;
  if (state && (state.left === tabId || state.right === tabId)) return { ...state, focused: state.left === tabId ? 0 : 1 };
  return { left: activeId, right: tabId, focused: 1 };
}

/**
 * 활성 탭이 바뀌었다(칸 클릭, 사이드바, ⌘1~9, ⌃Tab, 응답 필요 이동 …). 이미 한 칸에 있는 탭이면 그 칸으로 포커스만 옮기고,
 * 칸 밖의 탭이면 포커스된 칸의 탭을 바꾼다. 두 칸이 같은 탭이 되면 분할을 푼다.
 */
export function syncActive(state: SplitState | null, activeId: string | null): SplitState | null {
  if (!state) return null;
  if (!activeId) return null;
  if (activeId === state.left) return state.focused === 0 ? state : { ...state, focused: 0 };
  if (activeId === state.right) return state.focused === 1 ? state : { ...state, focused: 1 };
  const next: SplitState = state.focused === 0 ? { ...state, left: activeId } : { ...state, right: activeId };
  return next.left === next.right ? null : next;
}

/**
 * 탭이 닫히거나 지워졌다. 한 칸의 탭이 없어지면 분할을 풀고 남은 칸의 탭(keep)을 돌려준다 — 호출자는 그 탭을 활성화한다.
 * 이걸 활성 탭 동기화보다 먼저 해야 한다: 탭을 닫으면 모델이 이웃 탭을 활성화하는데, 그걸 칸 교체로 받으면 남은 칸 대신 제3의 탭이 들어온다.
 */
export function pruneSplit(state: SplitState | null, openTabIds: string[]): { state: SplitState | null; keep?: string } {
  if (!state) return { state: null };
  const hasL = openTabIds.includes(state.left);
  const hasR = openTabIds.includes(state.right);
  if (hasL && hasR) return { state };
  if (hasL) return { state: null, keep: state.left };
  if (hasR) return { state: null, keep: state.right };
  return { state: null };
}

/** 한 칸을 분할에서 뺀다(탭은 열린 채로). 남은 칸의 탭을 돌려준다. */
export function closePane(state: SplitState, pane: 0 | 1): string {
  return pane === 0 ? state.right : state.left;
}

const KEY = "chat.split";

export function loadSplit(openTabIds: string[], activeId: string | null): { state: SplitState | null; ratio: number } {
  try {
    const raw = kvGet(KEY);
    if (!raw) return { state: null, ratio: 50 };
    const v = JSON.parse(raw) as Partial<SplitState> & { ratio?: unknown };
    const ratio = typeof v.ratio === "number" && Number.isFinite(v.ratio) ? Math.min(80, Math.max(20, v.ratio)) : 50;
    if (typeof v.left !== "string" || typeof v.right !== "string" || v.left === v.right) return { state: null, ratio };
    if (!openTabIds.includes(v.left) || !openTabIds.includes(v.right)) return { state: null, ratio };
    // 저장된 포커스보다 지금 활성 탭이 우선이다(앱을 다시 열면 모델이 기억한 활성 탭이 진실).
    const focused: 0 | 1 = activeId === v.right ? 1 : activeId === v.left ? 0 : v.focused === 1 ? 1 : 0;
    const state = { left: v.left, right: v.right, focused };
    return { state: activeId && activeId !== v.left && activeId !== v.right ? syncActive(state, activeId) : state, ratio };
  } catch {
    return { state: null, ratio: 50 };
  }
}

export function saveSplit(state: SplitState | null, ratio: number): void {
  kvSet(KEY, state ? JSON.stringify({ ...state, ratio: Math.round(ratio) }) : null);
}
