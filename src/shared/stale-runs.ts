// 앱이 도중에 꺼져 "진행 중" 으로 남은 기록(verify running · fanout running · review requested)을 다시 읽을 때 정리한다.
// 새 프로세스엔 그 실행이 없으므로 카드가 영원히 돌지 않게 실패/중단으로 닫는 이벤트를 만들어 준다.
import type { ChatEvent, FanoutEvent, ReviewEvent, VerifyEvent } from "./chat-events";

export const STALE_NOTE = "앱이 재시작되어 추적이 끊겼습니다.";

export function staleRunEvents(events: ChatEvent[], now = Date.now()): ChatEvent[] {
  const verify = new Map<string, VerifyEvent>();
  const fanout = new Map<string, FanoutEvent>();
  const review = new Map<string, ReviewEvent>();
  for (const e of events) {
    if (e.type === "verify" && !e.partial) verify.set(e.runId, e);
    else if (e.type === "fanout") fanout.set(e.fanoutId, e);
    else if (e.type === "review") review.set(e.reviewTabId, e);
  }
  const out: ChatEvent[] = [];
  for (const v of verify.values())
    if (v.status === "running")
      out.push({
        ...v,
        ts: now,
        status: "aborted",
        commands: v.commands.map((c) => (c.status === "running" ? { ...c, status: "aborted", output: `${c.output ?? ""}\n(${STALE_NOTE})`.trim() } : c.status === "pending" ? { ...c, status: "skipped" } : c)),
      });
  for (const f of fanout.values())
    if (f.status === "running")
      out.push({
        ...f,
        ts: now,
        status: "done",
        variants: f.variants.map((x) => (x.status === "running" || x.status === "waiting" ? { ...x, status: "failed", error: `${STALE_NOTE} 변형 탭에서 직접 확인하세요.` } : x)),
      });
  for (const r of review.values()) if (r.status === "requested") out.push({ ...r, ts: now, status: "failed", text: `${STALE_NOTE} 리뷰 탭을 열어 확인하세요.` });
  return out;
}
