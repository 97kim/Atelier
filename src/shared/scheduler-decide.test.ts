import test from "node:test";
import assert from "node:assert/strict";
import { decideTick, readPrecheck } from "@shared/scheduler-decide";
import { createI18n } from "@shared/i18n";
import { isFinalRunStatus, missedBeyondGrace, shouldCoalesceSkip, type Run, type Schedule } from "@shared/schedules";

const { t } = createI18n("ko");
const en = createI18n("en").t;

const TICK = 30_000;
const base: Schedule = {
  id: "s1",
  name: "아침 점검",
  cron: "30 9 * * *",
  timezone: "Asia/Seoul",
  prompt: "어제 바뀐 것 요약해줘",
  provider: "claude",
  policy: "ask",
  target: { kind: "fresh", worktree: true },
  enabled: true,
  missedRunGraceMinutes: 120,
  createdAt: 0,
  activeSince: 0,
};
const tick = (over: Partial<Parameters<typeof decideTick>[1]> = {}) =>
  decideTick(t, { schedule: base, dueAt: 1_000_000, now: 1_000_000, tickMs: TICK, liveRuns: [], targetUnavailable: null, budgetBlocked: null, ...over });
const liveRun = (): Run => ({
  id: "r1", scheduleId: "s1", scheduledFor: 999_000, trigger: "scheduled", status: "running",
  snapshot: { prompt: base.prompt, cron: base.cron, timezone: base.timezone, policy: base.policy, provider: base.provider, target: base.target },
  startedAt: 999_000, endedAt: null, tabId: "t1", reason: null,
});

test("아직 시각이 아니면 아무것도 안 한다", () => {
  assert.deepEqual(tick({ now: 999_999 }), { kind: "idle" });
  assert.deepEqual(tick({ dueAt: null }), { kind: "idle" }, "일어나지 않는 일정");
  assert.deepEqual(tick({ schedule: { ...base, enabled: false } }), { kind: "idle" });
});

test("켜기 전의 회차는 만회하지 않는다", () => {
  assert.deepEqual(tick({ schedule: { ...base, activeSince: 1_000_001 } }), { kind: "idle" });
});

test("시각이 됐고 막는 것이 없으면 실행한다", () => {
  assert.deepEqual(tick(), { kind: "dispatch", scheduledFor: 1_000_000 });
  assert.deepEqual(tick({ schedule: { ...base, precheck: { command: "true", timeoutMs: 1000 } } }), {
    kind: "precheck",
    scheduledFor: 1_000_000,
  });
});

test("유예를 넘기면 건너뛴다 — 겹침보다 먼저 본다", () => {
  const late = 1_000_000 + 120 * 60_000 + TICK * 2 + 1;
  const d = tick({ now: late, liveRuns: [liveRun()] });
  assert.equal(d.kind, "skip");
  assert.equal(d.kind === "skip" && d.status, "skipped_missed", "늦은 것이 먼저다");
});

test("유예 안이면 늦어도 실행한다 — 틱 흔들림을 유예에 더한다", () => {
  const justInside = 1_000_000 + 120 * 60_000 + TICK * 2;
  assert.equal(tick({ now: justInside }).kind, "dispatch");
  assert.equal(missedBeyondGrace({ schedule: base, scheduledFor: 1_000_000, now: justInside, tickMs: TICK }), false);
});

test("앞 회차가 살아 있으면 겹침으로 건너뛴다", () => {
  const d = tick({ liveRuns: [liveRun()] });
  assert.equal(d.kind === "skip" && d.status, "skipped_overlap");
});

test("대상이 없거나 예산을 넘기면 건너뛴다 — 사유를 그대로 남긴다", () => {
  const a = tick({ targetUnavailable: { reason: "탭이 사라졌습니다.", reasonMsg: { key: "schedules.msg.noFolder" } } });
  assert.equal(a.kind === "skip" && a.reason, "탭이 사라졌습니다.");
  const b = tick({ budgetBlocked: { reason: "이번 달 예산을 넘겼습니다.", reasonMsg: { key: "schedules.msg.budgetExceeded" } } });
  assert.equal(b.kind === "skip" && b.status, "skipped_unavailable");
});

test("precheck 결과: 조건 불충족과 고장을 구분한다", () => {
  assert.deepEqual(readPrecheck(t, { exitCode: 0, timedOut: false, error: null }), { kind: "run" });
  assert.equal(readPrecheck(t, { exitCode: 1, timedOut: false, error: null }).kind, "skip");
  assert.equal(readPrecheck(t, { exitCode: 127, timedOut: false, error: null }).kind, "failed", "명령 없음은 고장이다");
  assert.equal(readPrecheck(t, { exitCode: null, timedOut: true, error: null }).kind, "failed");
  assert.equal(readPrecheck(t, { exitCode: null, timedOut: false, error: "spawn ENOENT" }).kind, "failed");
});

test("끝난 상태만 이력에서 지울 수 있다", () => {
  for (const s of ["completed", "failed", "interrupted", "skipped_missed", "skipped_overlap"] as const) assert.equal(isFinalRunStatus(s), true, s);
  for (const s of ["pending", "running", "needs_action"] as const) assert.equal(isFinalRunStatus(s), false, s);
});

test("같은 사유의 건너뜀은 합친다 — 이력이 밀려나지 않게", () => {
  const skipped: Run = { ...liveRun(), status: "skipped_overlap", reason: "앞 회차가 아직 끝나지 않았습니다." };
  assert.equal(shouldCoalesceSkip(skipped, "skipped_overlap", "앞 회차가 아직 끝나지 않았습니다."), true);
  assert.equal(shouldCoalesceSkip(skipped, "skipped_overlap", "다른 사유"), false);
  assert.equal(shouldCoalesceSkip(skipped, "completed", null), false, "완료는 합치지 않는다");
  assert.equal(shouldCoalesceSkip(null, "skipped_missed", "x"), false);
});

test("같은 사유는 언어가 달라 문장이 달라도 합친다 — Msg 가 있으면 키와 값으로 비교", () => {
  const overlapKo = { ...liveRun(), status: "skipped_overlap" as const, reason: "앞 회차가 아직 끝나지 않았습니다.", reasonMsg: { key: "schedules.msg.overlap" as const } };
  assert.equal(shouldCoalesceSkip(overlapKo, "skipped_overlap", en("schedules.msg.overlap"), { key: "schedules.msg.overlap" }), true);
  assert.equal(shouldCoalesceSkip(overlapKo, "skipped_overlap", "앞 회차가 아직 끝나지 않았습니다.", { key: "schedules.msg.missedGrace" }), false);
  const exitKo = { ...overlapKo, status: "skipped_unavailable" as const, reasonMsg: { key: "schedules.msg.budgetExceeded" as const, params: { spent: "1.00", budget: "2.00" } } };
  assert.equal(shouldCoalesceSkip(exitKo, "skipped_unavailable", "x", { key: "schedules.msg.budgetExceeded", params: { spent: "1.00", budget: "2.00" } }), true);
  assert.equal(shouldCoalesceSkip(exitKo, "skipped_unavailable", "x", { key: "schedules.msg.budgetExceeded", params: { spent: "1.50", budget: "2.00" } }), false);
});

test("Msg 없는 예전 기록은 문장으로 비교한다", () => {
  const old: Run = { ...liveRun(), status: "skipped_overlap", reason: "앞 회차가 아직 끝나지 않았습니다." };
  assert.equal(shouldCoalesceSkip(old, "skipped_overlap", "앞 회차가 아직 끝나지 않았습니다.", { key: "schedules.msg.overlap" }), true);
  assert.equal(shouldCoalesceSkip(old, "skipped_overlap", "The previous run hasn't finished yet.", { key: "schedules.msg.overlap" }), false);
});
