// 컨텍스트 경고 배너 "닫기" 기억. ChatView 는 탭마다 다시 마운트되므로 컴포넌트 밖(탭 id 키)에 둔다.
export interface CtxDismissed {
  pct: number;
  level: "warn" | "critical";
}

const map = new Map<string, CtxDismissed>();

export function getCtxDismissed(tabId: string): CtxDismissed | null {
  return map.get(tabId) ?? null;
}

export function setCtxDismissed(tabId: string, v: CtxDismissed | null): void {
  if (v) map.set(tabId, v);
  else map.delete(tabId);
}

/**
 * 배너를 다시 보일지: 닫은 뒤 5%p 더 찼거나, warn 에서 닫았는데 critical 로 넘어갔으면 다시 띄운다.
 * (pct 는 100 에서 멈추므로 "+5" 만으로는 critical 구간에서 영구히 숨을 수 있다.)
 */
export function shouldShowCtxBanner(
  pct: number,
  level: "warn" | "critical",
  dismissed: CtxDismissed | null,
): boolean {
  if (!dismissed) return true;
  if (level === "critical" && dismissed.level !== "critical") return true;
  return pct >= dismissed.pct + 5;
}
