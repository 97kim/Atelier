// 앱이 도중에 꺼져 "진행 중" 으로 남은 기록(verify running · fanout running · review requested)을 다시 읽을 때 정리한다.
// 새 프로세스엔 그 실행이 없으므로 카드가 영원히 돌지 않게 실패/중단으로 닫는 이벤트를 만들어 준다.
import type { ChatEvent, FanoutEvent, ReviewEvent, SessionStatus, VerifyEvent } from "./chat-events";

export const STALE_NOTE = "앱이 재시작되어 추적이 끊겼습니다.";

export function staleRunEvents(events: ChatEvent[], now = Date.now()): ChatEvent[] {
  const verify = new Map<string, VerifyEvent>();
  const fanout = new Map<string, FanoutEvent>();
  const review = new Map<string, ReviewEvent>();
  // 결과가 오지 않은 도구와, 마지막으로 남은 상태. 둘 다 그 프로세스의 것이라 이 프로세스엔 없다.
  const openTools = new Set<string>();
  let lastStatus: SessionStatus | null = null;
  for (const e of events) {
    if (e.type === "verify" && !e.partial) verify.set(e.runId, e);
    else if (e.type === "fanout") fanout.set(e.fanoutId, e);
    else if (e.type === "review") review.set(e.reviewTabId, e);
    else if (e.type === "tool_use") openTools.add(e.toolUseId);
    else if (e.type === "tool_result") openTools.delete(e.toolUseId);
    else if (e.type === "status") lastStatus = e.status;
  }
  const out: ChatEvent[] = [];
  // 화면은 기록을 재생해 만들어진다 — 닫히지 않은 도구 카드는 앱을 다시 켜도 계속 "실행 중" 으로 시간을 센다.
  for (const toolUseId of openTools) out.push({ type: "tool_result", ts: now, toolUseId, output: STALE_NOTE, isError: true });
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
  // 마지막이 "도는 중" 이면 화면은 영영 돈다. main 은 새 프로세스라 idle 인데 화면만 어긋나고,
  // 그 상태로는 중단도 듣지 않는다 — main 입장에선 이미 끝난 탭이라 끊을 것이 없다.
  // 조용히 idle 로 바꾸면 하던 일이 끝난 것처럼 보인다 — 끊겼다는 것을 글로 남기고 상태를 내린다.
  if (lastStatus && lastStatus !== "idle" && lastStatus !== "error") {
    out.push({ type: "error", ts: now, message: `중단됨 — ${STALE_NOTE}`, fatal: false });
    out.push({ type: "status", ts: now, status: "idle" });
  }
  return out;
}
