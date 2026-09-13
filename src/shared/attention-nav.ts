// "응답 필요 세션으로 점프": 열린 탭 순서를 따라 다음/이전 응답 필요 탭을 고른다. 순수 함수.
import type { SessionAttention } from "./ipc";

export function nextAttentionTab(
  openTabIds: string[],
  attention: Record<string, SessionAttention>,
  activeTabId: string | null,
  dir: 1 | -1 = 1,
): string | null {
  const candidates = openTabIds.filter((id) => attention[id]);
  if (candidates.length === 0) return null;
  const start = activeTabId ? openTabIds.indexOf(activeTabId) : -1;
  const n = openTabIds.length;
  // 활성 탭 다음(또는 이전)부터 한 바퀴 돌며 첫 후보. 활성 탭 자신은 마지막에.
  for (let step = 1; step <= n; step++) {
    const i = ((start + dir * step) % n + n) % n;
    const id = openTabIds[i];
    if (attention[id] && id !== activeTabId) return id;
  }
  return candidates[0];
}
