// 예약 실행 엔진. 매 틱마다 "지금 뭘 할까" 를 정하고, 정한 것을 실행하고, 회차의 끝을 지켜본다.
//
// 바깥과 닿는 부분은 전부 주입받는다(세션 만들기·프롬프트 보내기·precheck·예산). 그래야 Electron 없이 시험한다.
//
// 세 가지를 지킨다.
//   1) 회차는 보내기 전에 기록한다. 그 사이에 죽으면 재시작 때 "중단" 으로 남는다.
//   2) 같은 예정 시각을 두 번 시작하지 않는다(store.hasRunFor).
//   3) 끝을 못 봤으면 성공으로 바꾸지 않는다.

import { nextOccurrence, parseCron } from "@shared/cron";
import { decideTick, readPrecheck } from "@shared/scheduler-decide";
import {
  isFinalRunStatus,
  type PrecheckResult,
  type Run,
  type RunStatus,
  type Schedule,
  type ScheduleTarget,
} from "@shared/schedules";
import { applyRunSignal, newRunState, runVerdict, type RunSignal, type RunState } from "@shared/run-completion";
import type { ScheduleStore } from "./schedule-store";

export const TICK_MS = 30_000;

export interface ScheduleEngineDeps {
  store: ScheduleStore;
  now?(): number;
  /** 대상이 지금 실행 가능한가. 안 되면 사람이 읽을 사유. */
  checkTarget(target: ScheduleTarget): string | null;
  /** 예산 등으로 지금 시작하면 안 되는 사유. */
  checkBudget(): string | null;
  runPrecheck(input: { command: string; timeoutMs: number; target: ScheduleTarget }): Promise<PrecheckResult>;
  /** 세션을 준비하고 프롬프트를 보낸다. 돌아간 탭 id 를 준다. */
  dispatch(input: { schedule: Schedule; run: Run }): Promise<{ tabId: string }>;
  /** 회차 상태가 바뀌었다(화면 갱신·알림용). */
  onRunChanged?(run: Run): void;
  log?(line: string): void;
}

interface Watch {
  runId: string;
  scheduleId: string;
  state: RunState;
}

export class ScheduleEngine {
  private readonly deps: ScheduleEngineDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 탭 id → 지켜보는 회차. 한 탭에 한 회차만 둔다(겹침을 막으므로 그럴 일이 없다). */
  private readonly watching = new Map<string, Watch>();
  /** 지금 처리 중인 예약. 틱이 겹쳐 같은 회차를 두 번 시작하지 않게. */
  private readonly busy = new Set<string>();

  constructor(deps: ScheduleEngineDeps) {
    this.deps = deps;
  }

  private now(): number {
    return this.deps.now ? this.deps.now() : Date.now();
  }

  /** 앱이 켜질 때 한 번. 끝을 못 본 회차를 정리한다. */
  start(): void {
    const stranded = this.deps.store.reconcileOnStart("앱이 회차의 끝을 보기 전에 종료됐습니다.");
    if (stranded.length > 0) this.deps.log?.(`[schedules] 끝을 못 본 회차 ${stranded.length}개를 중단으로 정리했습니다.`);
    for (const r of stranded) this.deps.onRunChanged?.(r);
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), TICK_MS);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** 이 예약의 다음 예정 시각. 화면에도 쓴다. */
  nextRunAt(s: Schedule, after = this.now()): number | null {
    const cron = parseCron(s.cron);
    if (!cron) return null;
    try {
      return nextOccurrence(cron, Math.max(after, s.activeSince - 1), s.timezone);
    } catch {
      // 시간대 이름이 잘못 저장돼 있으면 Intl 이 던진다. 그 예약 하나만 "계산 불가" 로 두고
      // 목록 조회와 다른 예약의 틱까지 죽이지 않는다.
      return null;
    }
  }

  /**
   * 한 틱. 예약마다 "지난 예정 시각 중 아직 처리 안 한 가장 최근 것" 하나만 본다 —
   * 밀린 회차를 한꺼번에 몰아 돌리지 않는다.
   */
  async tick(): Promise<void> {
    const now = this.now();
    for (const schedule of this.deps.store.schedules()) {
      if (this.busy.has(schedule.id)) continue;
      const { due, staleGap, cursorTo } = this.latestUnhandledDue(schedule, now);
      this.busy.add(schedule.id);
      try {
      if (staleGap && schedule.enabled) {
        // 오래 꺼져 있었다. 밀린 회차를 하나씩 따라가면(매분 예약이면 수만 번) 현재에 닿는 데 몇 시간이 걸린다.
        // 한 줄만 남기고 커서를 창 시작점으로 민다 — 현재 회차는 이 틱에서 그대로 처리한다.
        this.skip(schedule, cursorTo, "skipped_missed", "앱이 오래 꺼져 있어 그동안의 회차를 건너뜁니다.");
      }
      const decision = decideTick({
        schedule,
        dueAt: due,
        now,
        tickMs: TICK_MS,
        liveRuns: this.deps.store.liveRuns(schedule.id),
        targetUnavailable: this.deps.checkTarget(schedule.target),
        budgetBlocked: this.deps.checkBudget(),
      });
      if (decision.kind !== "idle") {
        if (decision.kind === "skip") {
          this.skip(schedule, decision.scheduledFor, decision.status, decision.reason);
        } else {
          await this.run(schedule, decision.scheduledFor, decision.kind === "precheck", "scheduled");
        }
      }
      } catch (e) {
        this.deps.log?.(`[schedules] ${schedule.name}: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        this.busy.delete(schedule.id);
      }
    }
  }

  /** 지금 한 번 돌린다(수동). 예정 회차와 같은 검사를 거친다. */
  async runNow(scheduleId: string): Promise<Run | null> {
    const schedule = this.deps.store.schedule(scheduleId);
    if (!schedule) return null;
    if (this.deps.store.liveRuns(scheduleId).length > 0) {
      return this.skip(schedule, this.now(), "skipped_overlap", "앞 회차가 아직 끝나지 않았습니다.");
    }
    const unavailable = this.deps.checkTarget(schedule.target) ?? this.deps.checkBudget();
    if (unavailable) return this.skip(schedule, this.now(), "skipped_unavailable", unavailable);
    return this.run(schedule, this.now(), Boolean(schedule.precheck), "manual");
  }

  /**
   * 아직 회차를 만들지 않은 예정 시각 중 가장 최근 것. 없으면 null.
   * 밀린 것을 전부 재생하지 않으려고 "가장 최근 하나" 만 본다.
   */
  private latestUnhandledDue(s: Schedule, now: number): { due: number | null; staleGap: boolean; cursorTo: number } {
    const cron = parseCron(s.cron);
    if (!cron) return { due: null, staleGap: false, cursorTo: now };
    const last = this.deps.store.lastRun(s.id);
    // 훑기 시작점을 "유예 안에 들 수 있는 구간" 으로 자른다. 그보다 오래된 회차는 어차피
    // 유예 초과라 건너뛸 것이고, 매분 예약을 한 달 꺼 두면 그 옛 회차부터 한 틱에 하나씩
    // 처리하느라 현재 회차에 도달하는 데 몇 시간이 걸린다(코덱스가 30일로 재현했다).
    // 유예가 아무리 커도 훑는 창은 묶어 둔다. 창이 크면 탐색 상한(1000)에 먼저 걸려
    // "가장 최근" 대신 한참 과거 회차를 골라 버린다(매분 예약 + 유예 1440분에서 재현됐다).
    const windowMs = Math.min(
      Math.max(0, s.missedRunGraceMinutes) * 60_000 + TICK_MS * 2 + 60 * 60_000,
      12 * 60 * 60_000,
    );
    const since = Math.max(s.activeSince - 1, last ? last.scheduledFor : s.activeSince - 1);
    // 창보다 오래된 회차가 남아 있나(= 앱이 오래 꺼져 있었나). 한 번만 계산한다.
    let staleGap = false;
    try {
      const firstMissed = nextOccurrence(cron, since, s.timezone);
      staleGap = firstMissed !== null && firstMissed < now - windowMs;
    } catch {
      return { due: null, staleGap: false, cursorTo: now };
    }
    const windowStart = now - windowMs;
    const from = Math.max(since, windowStart);
    let due: number | null = null;
    let cursor = from;
    for (let i = 0; i < 1000; i += 1) {
      let t: number | null;
      try {
        t = nextOccurrence(cron, cursor, s.timezone);
      } catch {
        return { due: null, staleGap: false, cursorTo: now }; // 시간대가 잘못 저장됐다 — 이 예약만 멈춘다
      }
      if (t === null || t > now) break;
      if (!this.deps.store.hasRunFor(s.id, t)) due = t;
      cursor = t;
    }
    return { due, staleGap, cursorTo: windowStart };
  }

  private snapshotOf(s: Schedule): Run["snapshot"] {
    return { prompt: s.prompt, cron: s.cron, timezone: s.timezone, policy: s.policy, provider: s.provider, target: s.target };
  }

  private skip(s: Schedule, scheduledFor: number, status: RunStatus, reason: string): Run {
    const now = this.now();
    const make = (): Run => ({
      id: `${s.id}-${scheduledFor}-${Math.random().toString(36).slice(2, 8)}`,
      scheduleId: s.id,
      scheduledFor,
      trigger: "scheduled",
      status,
      snapshot: this.snapshotOf(s),
      startedAt: null,
      endedAt: now,
      tabId: null,
      reason,
    });
    const { run, coalesced } = this.deps.store.recordSkip({ scheduleId: s.id, scheduledFor, status, reason, make });
    if (!coalesced) this.deps.log?.(`[schedules] ${s.name}: ${status} — ${reason}`);
    this.deps.onRunChanged?.(run);
    return run;
  }

  /** 회차를 기록하고(보내기 전에!), precheck 를 거쳐, 보낸다. */
  private async run(s: Schedule, scheduledFor: number, withPrecheck: boolean, trigger: Run["trigger"]): Promise<Run> {
    const created = this.deps.store.createRun({
      id: `${s.id}-${scheduledFor}-${Math.random().toString(36).slice(2, 8)}`,
      scheduleId: s.id,
      scheduledFor,
      trigger,
      status: "pending",
      snapshot: this.snapshotOf(s),
      startedAt: null,
      endedAt: null,
      tabId: null,
      reason: null,
    });
    this.deps.onRunChanged?.(created);

    if (withPrecheck && s.precheck) {
      const result = await this.deps.runPrecheck({ command: s.precheck.command, timeoutMs: s.precheck.timeoutMs, target: s.target });
      const verdict = readPrecheck(result);
      if (verdict.kind !== "run") {
        return this.finish(created.id, verdict.kind === "skip" ? "skipped_precheck" : "failed", verdict.reason, { precheck: result });
      }
      this.deps.store.updateRun(created.id, { precheck: result });
    }

    try {
      const { tabId } = await this.deps.dispatch({ schedule: s, run: created });
      const started = this.deps.store.updateRun(created.id, { status: "running", startedAt: this.now(), tabId });
      if (started) this.deps.onRunChanged?.(started);
      this.watching.set(tabId, { runId: created.id, scheduleId: s.id, state: newRunState() });
      return started ?? created;
    } catch (e) {
      return this.finish(created.id, "failed", `실행을 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private finish(runId: string, status: RunStatus, reason: string | null, patch: Partial<Run> = {}): Run {
    const run = this.deps.store.updateRun(runId, { status, reason, endedAt: this.now(), ...patch });
    if (run) this.deps.onRunChanged?.(run);
    return run!;
  }

  /**
   * 지켜보는 탭에서 온 신호. 회차의 끝은 이 신호들로만 판정한다 —
   * 첫 result 는 끝이 아니고, 정리가 만든 빈 작업 목록은 근거가 아니다.
   */
  onSignal(tabId: string, signal: RunSignal): void {
    const w = this.watching.get(tabId);
    if (!w) return;
    w.state = applyRunSignal(w.state, signal);
    const v = runVerdict(w.state);
    if (v.state === "needs_action") {
      const run = this.deps.store.updateRun(w.runId, { status: "needs_action" });
      if (run) this.deps.onRunChanged?.(run);
      return;
    }
    if (v.state === "running") {
      // 승인을 받고 다시 도는 중이면 표시를 되돌린다 — needs_action 이 남아 있으면
      // 사람이 계속 기다리는 줄 안다.
      const cur = this.deps.store.runs(w.scheduleId).find((r) => r.id === w.runId);
      if (cur?.status === "needs_action") {
        const run = this.deps.store.updateRun(w.runId, { status: "running" });
        if (run) this.deps.onRunChanged?.(run);
      }
      return;
    }
    this.watching.delete(tabId);
    if (v.state === "completed") this.finish(w.runId, v.isError ? "failed" : "completed", v.isError ? "모델이 오류로 끝냈습니다." : null);
    else this.finish(w.runId, "interrupted", v.reason);
  }

  /** 지금 지켜보는 회차가 있는 탭인가(어댑터 신호를 흘려보낼지 정할 때). */
  watches(tabId: string): boolean {
    return this.watching.has(tabId);
  }

  /** 시험·진단용. */
  watchingCount(): number {
    return this.watching.size;
  }
}

export { isFinalRunStatus };
