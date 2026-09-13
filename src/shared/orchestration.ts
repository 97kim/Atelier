// 오케스트레이션(Orca 모델을 Atelier 에 맞춘 것)의 순수 부분: 타입, Run 별 도메인 이벤트, 리듀서, 워커 preamble.
// 실제 실행·저장·대기는 main/orchestration.ts. 여기엔 부수효과가 없다.
//
// 개념: Run(코디네이터의 인박스·이름 공간) > Task(작업) > Dispatch(그 작업의 권위 있는 시도 1개 = 탭 하나).
// 권한은 dispatchId + capability(실행 세대)에 묶인다. 탭이 살아 있는 것·프로세스가 살아 있는 것·턴이 도는 것·Dispatch 권한은 서로 다르다.
import type { PermissionPolicy } from "./chat-events";
import type { Provider } from "./ipc";
import type { WorktreeMeta } from "./workspace-model";

export const ORCH_PROTOCOL_VERSION = 1;
export const ORCH_MAX_DELIVERY = 50;
/** 1단계: 앱 전체에서 AI 코디네이터(탭)는 하나, 중첩 Run 없음. */
export const ORCH_MAX_AI_COORDINATORS = 1;

export type OrchActor = { kind: "user" } | { kind: "tab"; tabId: string } | { kind: "dispatch"; dispatchId: string } | { kind: "app" };

export interface OrchRun {
  id: string;
  objective: string;
  createdAt: number;
  createdBy: OrchActor;
  /** 지금 인박스를 소비하는 코디네이터. epoch 가 바뀌면 이전 소비자는 fenced. */
  coordinator: { kind: "user" | "tab"; tabId?: string; epoch: number; key: string };
  status: "active" | "closed";
  closedAt?: number;
}

export type OrchTaskStatus = "pending" | "running" | "succeeded" | "failed" | "abandoned";

export interface OrchTask {
  id: string;
  runId: string;
  seq: number;
  spec: string;
  createdAt: number;
  status: OrchTaskStatus;
  activeDispatchId: string | null;
  attempts: number;
  /** 먼저 succeeded 여야 하는 Task id 들(실행 순서만 뜻한다 — 산출물 전달은 spec 에 적는다). */
  deps: string[];
  outcome?: { status: "succeeded" | "failed" | "abandoned"; summary: string; filesModified?: string[]; dispatchId: string | null; at: number };
}

export type OrchExecutionState = "queued" | "running" | "waiting_permission" | "waiting_reply" | "limit_wait" | "idle" | "error" | "unknown";

export interface OrchDispatch {
  id: string;
  runId: string;
  taskId: string;
  attempt: number;
  tabId: string;
  provider: Provider;
  model?: string;
  policy: PermissionPolicy;
  cwd: string;
  worktree?: WorktreeMeta;
  /** 이 시도의 실행 세대. 워커 명령은 이 값을 --capability 로 실어야 한다. */
  capability: string;
  /** starting: 탭을 만드는 중 · live: 프롬프트 전송됨 · reported: 완료 보고 수락 · settled: 보고 수락 + 실행 정지 확인 · abandoned/failed_to_start */
  status: "starting" | "live" | "reported" | "settled" | "abandoned" | "failed_to_start";
  startedAt: number;
  startStage: "creating_workspace" | "creating_tab" | "configured" | "queued" | "started" | "failed";
  startError?: string;
  /** 앱이 관측한 실행 상태(권한은 아님). */
  execution: { state: OrchExecutionState; observedAt: number };
  /** 워커가 읽었다고 확정된 follow-up seq(다음 check 가 오면 직전 배치는 받은 것으로 본다). */
  lastCheckSeq: number;
  /** 직전 check 가 돌려준 배치의 최대 seq — 응답이 유실됐을 수 있어 다음 check 에서 한 번 더 준다. */
  pendingCheckSeq: number;
  /** worker-start 의 멱등 키. */
  requestId?: string;
  /** 프롬프트를 보낸 시점의 탭 이벤트 수 — 그 뒤 turn_result 가 있어야 "턴이 끝난" 것(재시작 뒤에도 유효). */
  startEventCount?: number;
  report?: { outcome: "succeeded" | "failed"; summary: string; filesModified?: string[]; at: number };
  /** 보고 없이 턴이 끝난 것을 앱이 통지했는지. */
  reportMissingNotified?: boolean;
  /** supervised: Run 이 감독 · retained: 사용자가 보존 요청 · released: 감독 해제(탭은 남는다) */
  ownership: "supervised" | "retained" | "released";
  stopRequestedAt?: number;
  settledAt?: number;
  /** 탭을 닫고 worktree 를 지운 뒤(명시적 worker-cleanup). */
  cleaned?: { tabClosed: boolean; worktreeRemoved: boolean; at: number };
}

export type OrchMessageType = "question" | "reply" | "escalation" | "worker_done" | "followup" | "note";

export interface OrchMessage {
  id: string;
  runId: string;
  seq: number;
  ts: number;
  from: OrchActor;
  /** run = 코디네이터 인박스, dispatch:<id> = 그 워커의 인박스 */
  to: "run" | `dispatch:${string}`;
  type: OrchMessageType;
  subject: string;
  body: string;
  taskId?: string;
  dispatchId?: string;
  /** question: 선택지 */
  options?: string[];
  /** question 의 멱등 키(CLI 가 재시도해도 질문이 두 번 생기지 않게) */
  requestId?: string;
  /** reply: 답한 질문 id */
  inReplyTo?: string;
  /** question 에 답이 붙으면 */
  answer?: { body: string; by: OrchActor; at: number; messageId: string };
  /** worker_done 의 결과 */
  outcome?: "succeeded" | "failed";
  filesModified?: string[];
  /** note 의 종류(앱 발신) */
  noteKind?: "turn_ended_without_report" | "permission_pending" | "start_failed" | "stop_requested" | "abandoned" | "coordinator_changed" | "worker_tab_missing" | "gate_resolved";
}

/** 코디네이터(또는 사람)가 내려야 하는 DAG 결정. 미해결이면 그 Task 는 시작할 수 없다. */
export interface OrchGate {
  id: string;
  runId: string;
  taskId: string;
  question: string;
  options: string[];
  createdAt: number;
  resolution?: { choice: string; by: OrchActor; at: number };
}

export interface OrchDelivery {
  id: string;
  runId: string;
  consumerEpoch: number;
  messageIds: string[];
  deliveredAt: number;
  ackedAt?: number;
}

export interface OrchRunState {
  run: OrchRun;
  tasks: OrchTask[];
  dispatches: OrchDispatch[];
  messages: OrchMessage[];
  deliveries: OrchDelivery[];
  gates: OrchGate[];
  /** 마지막으로 코디네이터 인박스에 전달된 메시지 seq(Delivery 로 포함된 것 중 최대). */
  deliveredSeq: number;
  revision: number;
}

// ===== 도메인 이벤트(Run 별 JSONL 의 원본) =====
interface EvBase {
  ts: number;
}
export type OrchEvent =
  | (EvBase & { type: "run_created"; run: OrchRun })
  | (EvBase & { type: "task_created"; task: OrchTask })
  | (EvBase & { type: "dispatch_created"; dispatch: OrchDispatch })
  | (EvBase & { type: "dispatch_stage"; dispatchId: string; stage: OrchDispatch["startStage"]; error?: string })
  | (EvBase & { type: "dispatch_placed"; dispatchId: string; tabId: string; cwd: string; worktree?: WorktreeMeta; startEventCount?: number })
  | (EvBase & { type: "dispatch_execution"; dispatchId: string; state: OrchExecutionState })
  | (EvBase & { type: "message"; message: OrchMessage })
  | (EvBase & { type: "question_answered"; questionId: string; answer: OrchMessage["answer"] })
  | (EvBase & { type: "report_accepted"; dispatchId: string; outcome: "succeeded" | "failed"; summary: string; filesModified?: string[] })
  | (EvBase & { type: "dispatch_settled"; dispatchId: string })
  | (EvBase & { type: "dispatch_ownership"; dispatchId: string; ownership: OrchDispatch["ownership"] })
  | (EvBase & { type: "dispatch_stop_requested"; dispatchId: string })
  | (EvBase & { type: "dispatch_abandoned"; dispatchId: string; reason: string })
  | (EvBase & { type: "dispatch_check"; dispatchId: string; seq: number; ack?: number })
  | (EvBase & { type: "messages"; messages: OrchMessage[] })
  | (EvBase & { type: "dispatch_start_cancelled"; dispatchId: string; reason: string })
  | (EvBase & { type: "dispatch_report_missing"; dispatchId: string })
  | (EvBase & { type: "delivery_created"; delivery: OrchDelivery })
  | (EvBase & { type: "delivery_acked"; deliveryId: string })
  | (EvBase & { type: "gate_created"; gate: OrchGate })
  | (EvBase & { type: "gate_resolved"; gateId: string; resolution: NonNullable<OrchGate["resolution"]> })
  | (EvBase & { type: "dispatch_cleaned"; dispatchId: string; tabClosed: boolean; worktreeRemoved: boolean })
  | (EvBase & { type: "coordinator_changed"; coordinator: OrchRun["coordinator"] })
  | (EvBase & { type: "run_closed" });

export function replayRun(events: OrchEvent[]): OrchRunState | null {
  let state: OrchRunState | null = null;
  for (const e of events) {
    if (e.type === "run_created") state = { run: e.run, tasks: [], dispatches: [], messages: [], deliveries: [], gates: [], deliveredSeq: 0, revision: 0 };
    else if (state) state = reduceRun(state, e);
  }
  return state;
}

function upd<T extends { id: string }>(list: T[], id: string, f: (t: T) => T): T[] {
  return list.map((t) => (t.id === id ? f(t) : t));
}

export function reduceRun(s: OrchRunState, e: OrchEvent): OrchRunState {
  const next = apply(s, e);
  return next === s ? s : { ...next, revision: s.revision + 1 };
}

function apply(s: OrchRunState, e: OrchEvent): OrchRunState {
  switch (e.type) {
    case "run_created":
      return s;
    case "task_created":
      return { ...s, tasks: [...s.tasks, { ...e.task, deps: e.task.deps ?? [] }] };
    case "gate_created":
      return { ...s, gates: [...s.gates, e.gate] };
    case "gate_resolved":
      return { ...s, gates: upd(s.gates, e.gateId, (g) => ({ ...g, resolution: e.resolution })) };
    case "dispatch_cleaned":
      return { ...s, dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, ownership: "released", cleaned: { tabClosed: e.tabClosed, worktreeRemoved: e.worktreeRemoved, at: e.ts } })) };
    case "dispatch_created":
      return {
        ...s,
        // 옛 기록(커서 필드가 없던 버전)도 안전하게: 빠진 커서는 0
        dispatches: [...s.dispatches, { ...e.dispatch, lastCheckSeq: e.dispatch.lastCheckSeq ?? 0, pendingCheckSeq: e.dispatch.pendingCheckSeq ?? e.dispatch.lastCheckSeq ?? 0 }],
        tasks: upd(s.tasks, e.dispatch.taskId, (t) => ({ ...t, status: "running", activeDispatchId: e.dispatch.id, attempts: t.attempts + 1 })),
      };
    case "dispatch_stage": {
      // 이미 끝난(abandoned/failed_to_start) 시도는 늦게 온 stage 로 되살아나지 않는다
      const cur = s.dispatches.find((d) => d.id === e.dispatchId);
      if (!cur || cur.status === "abandoned" || cur.status === "failed_to_start") return s;
      return {
        ...s,
        dispatches: upd(s.dispatches, e.dispatchId, (d) => ({
          ...d,
          startStage: e.stage,
          ...(e.stage === "started" ? { status: "live" as const } : {}),
          ...(e.stage === "failed" ? { status: "failed_to_start" as const, startError: e.error } : {}),
        })),
        ...(e.stage === "failed"
          ? { tasks: upd(s.tasks, s.dispatches.find((d) => d.id === e.dispatchId)?.taskId ?? "", (t) => ({ ...t, status: "pending", activeDispatchId: null })) }
          : {}),
      };
    }
    case "dispatch_start_cancelled": {
      const cur = s.dispatches.find((d) => d.id === e.dispatchId);
      if (!cur || cur.status !== "starting") return s;
      return {
        ...s,
        dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, status: "failed_to_start", startStage: "failed", startError: e.reason })),
        tasks: upd(s.tasks, cur.taskId, (t) => (t.activeDispatchId === cur.id ? { ...t, status: "pending", activeDispatchId: null } : t)),
      };
    }
    case "dispatch_placed":
      // 늦게 배치된 자원(시작 중 abandon 뒤 만들어진 탭)은 이전 "정리됨" 표시를 무효화해 다시 정리할 수 있게 한다
      return { ...s, dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, tabId: e.tabId, cwd: e.cwd, worktree: e.worktree, startStage: d.status === "starting" ? "configured" : d.startStage, cleaned: undefined, ...(e.startEventCount !== undefined ? { startEventCount: e.startEventCount } : {}) })) };
    case "dispatch_execution":
      return { ...s, dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, execution: { state: e.state, observedAt: e.ts } })) };
    case "message": {
      const m = e.message;
      const dispatches =
        m.type === "question" && m.dispatchId ? upd(s.dispatches, m.dispatchId, (d) => ({ ...d, execution: { state: "waiting_reply" as const, observedAt: e.ts } })) : s.dispatches;
      return { ...s, messages: [...s.messages, m], dispatches };
    }
    case "messages":
      // 그룹 fan-out: 한 이벤트(한 줄)에 여러 메시지 — 전부 남거나 전부 없거나
      return { ...s, messages: [...s.messages, ...e.messages] };
    case "question_answered":
      return { ...s, messages: upd(s.messages, e.questionId, (m) => ({ ...m, answer: e.answer })) };
    case "report_accepted": {
      const d = s.dispatches.find((x) => x.id === e.dispatchId);
      return {
        ...s,
        dispatches: upd(s.dispatches, e.dispatchId, (x) => ({ ...x, status: "reported", report: { outcome: e.outcome, summary: e.summary, filesModified: e.filesModified, at: e.ts } })),
        tasks: d ? upd(s.tasks, d.taskId, (t) => ({ ...t, status: e.outcome, outcome: { status: e.outcome, summary: e.summary, filesModified: e.filesModified, dispatchId: e.dispatchId, at: e.ts } })) : s.tasks,
      };
    }
    case "dispatch_settled": {
      const cur = s.dispatches.find((d) => d.id === e.dispatchId);
      if (!cur || cur.status !== "reported") return s;
      return {
        ...s,
        dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, status: "settled", settledAt: e.ts })),
        // 정산되면 Task 의 활성 시도 포인터를 푼다 — 실패한 Task 를 다시 시도할 수 있게(결과는 유지)
        tasks: upd(s.tasks, cur.taskId, (t) => (t.activeDispatchId === cur.id ? { ...t, activeDispatchId: null } : t)),
      };
    }
    case "dispatch_ownership":
      return { ...s, dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, ownership: e.ownership })) };
    case "dispatch_stop_requested":
      return { ...s, dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, stopRequestedAt: e.ts })) };
    case "dispatch_abandoned": {
      const d = s.dispatches.find((x) => x.id === e.dispatchId);
      return {
        ...s,
        dispatches: upd(s.dispatches, e.dispatchId, (x) => ({ ...x, status: "abandoned", settledAt: e.ts })),
        tasks: d ? upd(s.tasks, d.taskId, (t) => (t.activeDispatchId === d.id ? { ...t, status: "abandoned", activeDispatchId: null, outcome: { status: "abandoned", summary: e.reason, dispatchId: d.id, at: e.ts } } : t)) : s.tasks,
      };
    }
    case "dispatch_check":
      // seq = 이번에 돌려준 배치의 최대(전달됨), ack = 워커가 반영했다고 명시한 seq(확정). 확정 없이는 계속 재전달한다.
      return {
        ...s,
        dispatches: upd(s.dispatches, e.dispatchId, (d) => {
          const last = d.lastCheckSeq ?? 0;
          const pending = Math.max(d.pendingCheckSeq ?? last, e.seq ?? 0);
          const acked = e.ack !== undefined ? Math.max(last, Math.min(e.ack, pending)) : last;
          return { ...d, lastCheckSeq: acked, pendingCheckSeq: pending };
        }),
      };
    case "dispatch_report_missing":
      return { ...s, dispatches: upd(s.dispatches, e.dispatchId, (d) => ({ ...d, reportMissingNotified: true })) };
    case "delivery_created": {
      const maxSeq = Math.max(s.deliveredSeq, ...e.delivery.messageIds.map((id) => s.messages.find((m) => m.id === id)?.seq ?? 0));
      return { ...s, deliveries: [...s.deliveries, e.delivery], deliveredSeq: maxSeq };
    }
    case "delivery_acked":
      return { ...s, deliveries: upd(s.deliveries, e.deliveryId, (d) => ({ ...d, ackedAt: e.ts })) };
    case "coordinator_changed": {
      // 물러나는 소비자(현재 epoch)가 확인하지 않은 Delivery 의 메시지만 새 소비자에게 다시 전달한다(그 전 세대는 이미 대체됨)
      const unacked = s.deliveries.filter((d) => !d.ackedAt && d.consumerEpoch === s.run.coordinator.epoch);
      let deliveredSeq = s.deliveredSeq;
      for (const dl of unacked) for (const id of dl.messageIds) {
        const m = s.messages.find((x) => x.id === id);
        if (m) deliveredSeq = Math.min(deliveredSeq, m.seq - 1);
      }
      return { ...s, run: { ...s.run, coordinator: e.coordinator }, deliveredSeq };
    }
    case "run_closed":
      return { ...s, run: { ...s.run, status: "closed", closedAt: e.ts } };
  }
}

// ===== 조회 도우미 =====

/** 코디네이터 인박스: run 수신 메시지 중 아직 Delivery 에 안 담긴 것(FIFO). */
export function undeliveredInbox(s: OrchRunState): OrchMessage[] {
  return s.messages.filter((m) => m.to === "run" && m.seq > s.deliveredSeq);
}

/** 지금 소비자 epoch 의 미확인 Delivery(재전달 대상). */
export function pendingDelivery(s: OrchRunState): OrchDelivery | null {
  return s.deliveries.find((d) => d.consumerEpoch === s.run.coordinator.epoch && !d.ackedAt) ?? null;
}

/** 워커 인박스: 아직 확정 안 된 follow-up(직전 배치 포함 — 응답 유실 대비 재전달). */
export function unreadFollowups(s: OrchRunState, dispatchId: string): OrchMessage[] {
  const d = s.dispatches.find((x) => x.id === dispatchId);
  if (!d) return [];
  return s.messages.filter((m) => m.to === `dispatch:${dispatchId}` && m.type === "followup" && m.seq > d.lastCheckSeq);
}

/** 워커가 한 번도 받지 못한 follow-up(worker_done 을 막는 기준). 직전 check 가 돌려준 것은 받은 것으로 본다. */
export function undeliveredFollowups(s: OrchRunState, dispatchId: string): OrchMessage[] {
  const d = s.dispatches.find((x) => x.id === dispatchId);
  if (!d) return [];
  return s.messages.filter((m) => m.to === `dispatch:${dispatchId}` && m.type === "followup" && m.seq > d.pendingCheckSeq);
}

/** 사람이 봐야 할 것: 답 없는 질문, 에스컬레이션, 앱 통지. */
export function attention(s: OrchRunState): { questions: OrchMessage[]; escalations: OrchMessage[]; notes: OrchMessage[] } {
  const questions = s.messages.filter((m) => m.type === "question" && !m.answer);
  const escalations = s.messages.filter((m) => m.type === "escalation");
  const notes = s.messages.filter((m) => m.type === "note");
  return { questions, escalations, notes };
}

/** Task 를 지금 시작할 수 있는지: pending 이고, 의존 Task 가 모두 succeeded 이고, 미해결 게이트가 없다. */
export function taskBlockers(s: OrchRunState, task: OrchTask): { unmetDeps: string[]; pendingGates: OrchGate[] } {
  const unmetDeps = task.deps.filter((id) => s.tasks.find((t) => t.id === id)?.status !== "succeeded");
  const pendingGates = s.gates.filter((g) => g.taskId === task.id && !g.resolution);
  return { unmetDeps, pendingGates };
}

export function readyTasks(s: OrchRunState): OrchTask[] {
  return s.tasks.filter((t) => t.status === "pending" && !t.activeDispatchId && taskBlockers(s, t).unmetDeps.length === 0 && taskBlockers(s, t).pendingGates.length === 0);
}

/** Task 의 웨이브(1 + 의존 Task 웨이브의 최대). 독립 Task 는 1. */
export function taskWaves(s: OrchRunState): Map<string, number> {
  const out = new Map<string, number>();
  const level = (t: OrchTask, depth = 0): number => {
    const hit = out.get(t.id);
    if (hit) return hit;
    if (depth > 100) return 1;
    const w = 1 + Math.max(0, ...t.deps.map((id) => { const d = s.tasks.find((x) => x.id === id); return d ? level(d, depth + 1) : 0; }));
    out.set(t.id, w);
    return w;
  };
  for (const t of s.tasks) level(t);
  return out;
}

/** 그룹 주소 → 대상 Dispatch. @all/@idle/@claude/@codex 는 이 Run 의 살아 있는 시도. */
export function resolveGroup(s: OrchRunState, to: string): OrchDispatch[] | null {
  if (!to.startsWith("@")) return null;
  const live = s.dispatches.filter((d) => d.status === "live");
  switch (to) {
    case "@all":
      return live;
    case "@claude":
    case "@codex":
      return live.filter((d) => d.provider === to.slice(1));
    case "@idle":
      return live.filter((d) => d.execution.state === "idle" || d.execution.state === "error");
    default:
      return [];
  }
}

export function isSettledDispatch(d: OrchDispatch): boolean {
  return d.status === "settled" || d.status === "abandoned" || d.status === "failed_to_start";
}

/** Run 이 끝났는지: 모든 Task 가 pending/running 이 아니고 Dispatch 가 전부 정리됨. */
export function runSettled(s: OrchRunState): boolean {
  return s.tasks.length > 0 && s.tasks.every((t) => t.status !== "pending" && t.status !== "running") && s.dispatches.every((d) => !isOpenDispatch(d));
}

/** 아직 감독이 끝나지 않은 시도: 시작 중·실행 중·보고는 받았지만 실행 정지를 확인하기 전. */
export function isOpenDispatch(d: OrchDispatch): boolean {
  return d.status === "starting" || d.status === "live" || d.status === "reported";
}

export function runSummary(s: OrchRunState): string {
  const done = s.tasks.filter((t) => t.status === "succeeded").length;
  const failed = s.tasks.filter((t) => t.status === "failed" || t.status === "abandoned").length;
  const running = s.tasks.filter((t) => t.status === "running").length;
  const a = attention(s);
  const gates = s.gates.filter((g) => !g.resolution).length;
  const parts = [`${done}/${s.tasks.length} 완료`];
  if (running) parts.push(`${running} 진행`);
  if (gates) parts.push(`${gates} 게이트`);
  if (failed) parts.push(`${failed} 실패`);
  if (a.questions.length) parts.push(`${a.questions.length} 질문`);
  return parts.join(" · ");
}

// ===== 검증 =====
export function validateSpec(spec: unknown): { ok: true; spec: string } | { ok: false; error: string } {
  const s = typeof spec === "string" ? spec.trim() : "";
  if (!s) return { ok: false, error: "spec 이 비어 있습니다. 대상·변경·제약·소유 범위·완료 기준을 적어 주세요." };
  if (s.length > 20_000) return { ok: false, error: "spec 이 너무 깁니다(20,000자 이하)." };
  return { ok: true, spec: s };
}

// ===== 워커 preamble =====
export interface PreambleInput {
  cli: string;
  run: OrchRun;
  task: OrchTask;
  dispatch: OrchDispatch;
}

/** 워커 탭에 보내는 프롬프트 = preamble(실행 계약) + Task spec. 명령은 그대로 복사해 쓰게 정확히 적는다. */
export function buildWorkerPrompt(i: PreambleInput): string {
  const { cli, run, task, dispatch: d } = i;
  const ids = `--run ${run.id} --dispatch ${d.id} --capability ${d.capability}`;
  return [
    `[Atelier 오케스트레이션 · 워커 계약 v${ORCH_PROTOCOL_VERSION}]`,
    `당신은 이 Run 의 워커입니다. 아래 Task 하나만 수행하고, 끝나면 완료 보고를 정확히 한 번 보낸 뒤 이 턴을 끝내세요.`,
    ``,
    `- Run: ${run.id}  (목표: ${run.objective})`,
    `- Task: ${task.id}  Dispatch: ${d.id}  탭: ${d.tabId}`,
    `- 작업 경로: ${d.cwd}${d.worktree ? ` (격리 worktree, 브랜치 ${d.worktree.branch}, base ${d.worktree.base} 의 HEAD 에서 시작 — 원본의 커밋 안 된 변경은 여기 없습니다)` : " (공유 경로 — 다른 워커와 같은 파일을 건드리지 마세요)"}`,
    `- 제공자/정책: ${d.provider}${d.model ? ` (${d.model})` : ""} / ${d.policy}`,
    ``,
    `규칙:`,
    `1. 코디네이터에게 물어야 할 게 있으면 사람에게 묻는 화면을 띄우지 말고 아래 ask 명령을 쓰세요. 답이 올 때까지 막힙니다. 시간이 초과되면 같은 질문을 --resume <message_id> 로 다시 기다리세요(새 질문을 만들지 마세요).`,
    `   ${cli} orch ask ${ids} --question "<질문>" [--options "a,b"] --timeout-ms 600000`,
    `   ${cli} orch ask ${ids} --resume <message_id> --timeout-ms 600000`,
    `2. 새 파일을 시작하기 전·테스트를 돌린 뒤·완료 보고 직전에 코디네이터의 후속 지시를 읽으세요:`,
    `   ${cli} orch check ${ids}`,
    `   messages 가 있으면 반영한 뒤 응답의 ackSeq 로 확인하세요(확인 전엔 같은 지시가 다시 옵니다): ${cli} orch check ${ids} --ack <ackSeq>`,
    `   결과에 consumer_fenced 가 오면 이 Dispatch 는 더 이상 당신 것이 아닙니다. 즉시 멈추고 완료 보고를 보내지 마세요.`,
    `3. 막혀서 코디네이터가 개입해야 하면:`,
    `   ${cli} orch send ${ids} --type escalation --subject "Blocked: <이유>" --body "<상황>"`,
    `4. 완료 보고는 정확히 한 번, 성공/실패를 명시해서(세 문장 권장: 무엇을 바꿨나·무엇을 발견했나·무엇이 남았나):`,
    `   ${cli} orch send ${ids} --type worker_done --outcome succeeded|failed --subject "<한 줄 상태>" --body "<보고>" [--files-modified "a.ts,b.ts"]`,
    `   실패를 본문에만 숨기지 마세요. 보고 뒤에는 새 일을 시작하지 말고 이 턴을 끝내세요.`,
    `5. 다른 워커를 띄우거나 새 Run 을 만들지 마세요. 이 Task 범위 밖의 파일은 건드리지 마세요.`,
    ``,
    ...(task.deps.length ? [`- 이 Task 는 앞선 Task(${task.deps.join(", ")})가 끝난 뒤 시작됐습니다. 그 산출물이 필요하면 spec 에 적힌 위치에서 읽으세요.`, ``] : []),
    `=== Task ===`,
    task.spec,
  ].join("\n");
}

/** 코디네이터 탭에 붙이는 안내(run-create 를 탭이 했을 때). */
export function coordinatorHint(cli: string, run: OrchRun): string {
  return [
    `[Atelier 오케스트레이션 · 코디네이터] Run ${run.id} 이 만들어졌습니다. 워커를 띄운 뒤 인박스를 기다리세요:`,
    `${cli} orch worker-start --run ${run.id} --key ${run.coordinator.key} --spec "<작업>" --agent claude|codex [--worktree]`,
    `${cli} orch check --run ${run.id} --key ${run.coordinator.key} --wait --timeout-ms 900000`,
    `질문엔 reply, 완료 보고를 받으면 결과를 검증한 뒤 --ack <delivery_id> 로 다음을 기다립니다. 빈 대기는 실패가 아닙니다.`,
  ].join("\n");
}
