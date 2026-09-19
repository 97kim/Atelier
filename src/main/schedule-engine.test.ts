import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScheduleEngine, TICK_MS } from "./schedule-engine";
import { ScheduleStore } from "./schedule-store";
import type { PrecheckResult, Run, Schedule } from "@shared/schedules";

const KST = "Asia/Seoul";
const at = (iso: string) => Date.parse(iso);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "eng-"));

function harness(over: Partial<Schedule> = {}, deps: Partial<Parameters<typeof makeEngine>[1]> = {}) {
  const dir = tmp();
  const store = new ScheduleStore(dir);
  const s: Schedule = {
    id: "s1", name: "아침", cron: "30 9 * * *", timezone: KST, prompt: "요약해줘", provider: "claude",
    policy: "ask", target: { kind: "fresh", workspaceId: "w1", worktree: true },
    enabled: true, missedRunGraceMinutes: 120, createdAt: 0, activeSince: at("2026-09-18T00:00:00+09:00"), ...over,
  };
  store.upsertSchedule(s);
  return { dir, store, schedule: s, ...makeEngine(store, deps) };
}

function makeEngine(store: ScheduleStore, over: Record<string, unknown> = {}) {
  const dispatched: { tabId: string }[] = [];
  let clock = at("2026-09-19T09:30:00+09:00");
  const engine = new ScheduleEngine({
    store,
    now: () => clock,
    checkTarget: () => null,
    checkBudget: () => null,
    runPrecheck: async () => ok0,
    dispatch: async () => {
      const t = { tabId: `tab${dispatched.length + 1}` };
      dispatched.push(t);
      return t;
    },
    ...over,
  } as ConstructorParameters<typeof ScheduleEngine>[0]);
  return { engine, dispatched, setNow: (t: number) => (clock = t), now: () => clock };
}

const ok0: PrecheckResult = { command: "true", exitCode: 0, timedOut: false, durationMs: 1, stdout: "", stderr: "", error: null };

test("시각이 되면 회차를 만들고 보낸다 — 기록이 먼저다", async () => {
  const h = harness();
  await h.engine.tick();
  const runs = h.store.runs("s1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "running");
  assert.equal(runs[0].tabId, "tab1");
  assert.equal(runs[0].scheduledFor, at("2026-09-19T09:30:00+09:00"));
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("같은 회차를 두 번 시작하지 않는다", async () => {
  const h = harness();
  await h.engine.tick();
  await h.engine.tick();
  assert.equal(h.dispatched.length, 1, "두 번째 틱은 아무것도 안 한다");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("앞 회차가 살아 있으면 다음 회차는 겹침으로 건너뛴다", async () => {
  const h = harness();
  await h.engine.tick();                       // 09:30 회차 시작(running)
  h.setNow(at("2026-09-20T09:30:00+09:00"));   // 다음 날
  await h.engine.tick();
  const runs = h.store.runs("s1");
  assert.equal(runs[0].status, "skipped_overlap");
  assert.equal(h.dispatched.length, 1);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("오래 꺼져 있었으면 가장 최근 회차만, 그것도 유예 안일 때만", async () => {
  const h = harness();
  // 일주일 뒤에 깨어남 → 마지막 09:30 은 이미 몇 시간 지남(유예 2시간)
  h.setNow(at("2026-09-26T15:00:00+09:00"));
  await h.engine.tick();
  const runs = h.store.runs("s1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "skipped_missed");
  assert.equal(h.dispatched.length, 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("유예 안에 깨어나면 그 회차를 만회한다", async () => {
  const h = harness();
  h.setNow(at("2026-09-19T10:30:00+09:00")); // 1시간 늦음, 유예 2시간
  await h.engine.tick();
  assert.equal(h.store.runs("s1")[0].status, "running");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("precheck 가 1 이면 건너뛰고, 고장이면 실패다", async () => {
  const skip: PrecheckResult = { ...ok0, exitCode: 1 };
  const a = harness({ precheck: { command: "git diff --quiet", timeoutMs: 1000 } }, { runPrecheck: async () => skip });
  await a.engine.tick();
  assert.equal(a.store.runs("s1")[0].status, "skipped_precheck");
  assert.equal(a.dispatched.length, 0);
  fs.rmSync(a.dir, { recursive: true, force: true });

  const broken: PrecheckResult = { ...ok0, exitCode: 127 };
  const b = harness({ precheck: { command: "없는명령", timeoutMs: 1000 } }, { runPrecheck: async () => broken });
  await b.engine.tick();
  assert.equal(b.store.runs("s1")[0].status, "failed");
  fs.rmSync(b.dir, { recursive: true, force: true });
});

test("회차의 끝은 신호로 판정한다 — 첫 result 는 끝이 아니다", async () => {
  const h = harness();
  await h.engine.tick();
  const tab = "tab1";
  h.engine.onSignal(tab, { kind: "turn_started" });
  h.engine.onSignal(tab, { kind: "tasks", count: 1, source: "sdk" });
  h.engine.onSignal(tab, { kind: "result", isError: false });
  assert.equal(h.store.runs("s1")[0].status, "running", "백그라운드가 남았으면 아직이다");
  h.engine.onSignal(tab, { kind: "tasks", count: 0, source: "sdk" });
  h.engine.onSignal(tab, { kind: "turn_started" });
  h.engine.onSignal(tab, { kind: "result", isError: false });
  assert.equal(h.store.runs("s1")[0].status, "completed");
  assert.equal(h.engine.watchingCount(), 0, "끝난 회차는 더 안 지켜본다");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("크래시는 성공이 아니다 — 정리가 만든 빈 목록에 속지 않는다", async () => {
  const h = harness();
  await h.engine.tick();
  h.engine.onSignal("tab1", { kind: "turn_started" });
  h.engine.onSignal("tab1", { kind: "tasks", count: 1, source: "sdk" });
  h.engine.onSignal("tab1", { kind: "result", isError: false });
  h.engine.onSignal("tab1", { kind: "stream_ended", reason: "terminated by signal SIGKILL", expected: false });
  h.engine.onSignal("tab1", { kind: "tasks", count: 0, source: "cleanup" });
  const run = h.store.runs("s1")[0];
  assert.equal(run.status, "interrupted");
  assert.match(run.reason ?? "", /SIGKILL/);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("승인 대기는 따로 표시한다 — 무인 실행이 멈춘 것을 알아야 한다", async () => {
  const h = harness();
  await h.engine.tick();
  h.engine.onSignal("tab1", { kind: "awaiting", count: 1 });
  assert.equal(h.store.runs("s1")[0].status, "needs_action");
  h.engine.onSignal("tab1", { kind: "awaiting", count: 0 });
  h.engine.onSignal("tab1", { kind: "result", isError: false });
  assert.equal(h.store.runs("s1")[0].status, "completed");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("재시작하면 끝을 못 본 회차가 중단으로 남는다", async () => {
  const h = harness();
  await h.engine.tick();
  assert.equal(h.store.runs("s1")[0].status, "running");
  // 앱을 껐다 켠 상황
  const store2 = new ScheduleStore(h.dir);
  const { engine } = makeEngine(store2);
  engine.start();
  engine.stop();
  assert.equal(store2.runs("s1")[0].status, "interrupted");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("꺼진 예약은 돌지 않는다", async () => {
  const h = harness({ enabled: false });
  await h.engine.tick();
  assert.equal(h.store.runs("s1").length, 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("수동 실행도 같은 검사를 거친다", async () => {
  const h = harness({ enabled: false });
  const run = await h.engine.runNow("s1");
  assert.equal(run?.trigger, "manual");
  assert.equal(run?.status, "running", "꺼져 있어도 수동은 돈다");
  const again = await h.engine.runNow("s1");
  assert.equal(again?.status, "skipped_overlap", "앞 회차가 살아 있으면 겹침");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("틱 흔들림을 유예에 더한다(경계)", () => {
  const h = harness();
  const due = at("2026-09-19T09:30:00+09:00");
  h.setNow(due + 120 * 60_000 + TICK_MS * 2);
  assert.doesNotThrow(() => h.engine.nextRunAt(h.schedule));
  fs.rmSync(h.dir, { recursive: true, force: true });
});
