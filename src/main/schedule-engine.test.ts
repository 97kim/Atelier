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
    policy: "ask", target: { kind: "fresh", worktree: true },
    enabled: true, missedRunGraceMinutes: 120, createdAt: 0, activeSince: at("2026-09-19T00:00:00+09:00"), ...over,
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

test("오래 꺼져 있었으면 한 줄만 남기고 따라잡는다 — 밀린 회차를 하나씩 재생하지 않는다", async () => {
  const h = harness({ activeSince: at("2026-09-12T00:00:00+09:00") });
  // 일주일 뒤에 깨어남. 밀린 회차가 여럿이지만 기록은 하나여야 하고, 다음 틱은 바로 현재를 본다.
  h.setNow(at("2026-09-26T15:00:00+09:00"));
  await h.engine.tick();
  let runs = h.store.runs("s1");
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, "skipped_missed");
  assert.equal(h.dispatched.length, 0);

  // 그 다음 정상 회차는 제때 돈다(옛 회차를 따라가느라 막히지 않는다)
  h.setNow(at("2026-09-27T09:30:00+09:00"));
  await h.engine.tick();
  runs = h.store.runs("s1");
  assert.equal(runs[0].status, "running", `(${runs[0].status})`);
  assert.equal(h.dispatched.length, 1);
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

test("시간대가 잘못 저장돼도 그 예약만 멈춘다 — 목록과 다른 예약을 죽이지 않는다", async () => {
  const h = harness({ timezone: "Asia/Seol" });
  assert.equal(h.engine.nextRunAt(h.schedule), null, "계산 불가로 두고 던지지 않는다");
  await assert.doesNotReject(() => h.engine.tick());
  assert.equal(h.store.runs("s1").length, 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("저장이 실패하면 보내지 않는다 — 기록 없는 실행을 만들지 않는다", async () => {
  const h = harness();
  // 저장 경로를 못 쓰게 만든다(임시 파일 자리에 디렉터리).
  fs.mkdirSync(path.join(h.dir, "schedules.json.tmp"), { recursive: true });
  await h.engine.tick();
  assert.equal(h.dispatched.length, 0, "기록도 못 했는데 보내면 안 된다");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

// 아래는 코덱스 3차가 찾은 반례다.

test("대기열에서 취소돼도 회차가 끝난다 — 영영 도는 중으로 남지 않는다", async () => {
  const h = harness();
  await h.engine.tick();
  assert.equal(h.store.runs("s1")[0].status, "running");
  // 동시 실행 한도에 걸려 취소된 경우(치명적이지 않은 오류로 온다)
  h.engine.onSignal("tab1", { kind: "stream_ended", reason: "대기열에서 취소되었습니다.", expected: false });
  const run = h.store.runs("s1")[0];
  assert.equal(run.status, "interrupted");
  // 그래서 다음 회차가 겹침으로 막히지 않는다
  h.setNow(at("2026-09-20T09:30:00+09:00"));
  await h.engine.tick();
  assert.equal(h.store.runs("s1")[0].status, "running");
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("저장이 실패하면 메모리도 되돌린다 — 디스크가 복구되면 다시 돈다", async () => {
  const h = harness();
  const blocked = path.join(h.dir, "schedules.json.tmp");
  fs.mkdirSync(blocked, { recursive: true });
  await h.engine.tick();
  assert.equal(h.dispatched.length, 0);
  assert.equal(h.store.runs("s1").length, 0, "기록도 못 한 회차가 메모리에 남으면 안 된다");

  // 디스크가 돌아오면 같은 회차가 정상적으로 돈다
  fs.rmdirSync(blocked);
  await h.engine.tick();
  assert.equal(h.store.runs("s1")[0].status, "running");
  assert.equal(h.dispatched.length, 1);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("유예가 아주 커도 가장 최근 회차를 고른다", async () => {
  // 매분 예약 + 유예 하루. 창을 안 묶으면 탐색 상한에 걸려 한참 과거를 고른다.
  const h = harness({ cron: "* * * * *", missedRunGraceMinutes: 1440, activeSince: at("2026-08-20T00:00:00+09:00") });
  const now = at("2026-09-19T12:00:00+09:00");
  h.setNow(now);
  await h.engine.tick();
  const runs = h.store.runs("s1");
  const picked = runs.find((r) => r.status === "running");
  assert.ok(picked, `실행된 회차가 없다: ${JSON.stringify(runs.map((r) => r.status))}`);
  const lateBy = (now - picked.scheduledFor) / 60_000;
  assert.ok(lateBy <= 2, `${lateBy}분 전 회차를 골랐다`);
  fs.rmSync(h.dir, { recursive: true, force: true });
});

test("종료 기록이 실패하면 감시를 놓지 않는다", async () => {
  const h = harness();
  await h.engine.tick();
  assert.equal(h.engine.watchingCount(), 1);
  // 저장을 막아 둔 채 완료 신호를 준다
  const blocked = path.join(h.dir, "schedules.json.tmp");
  fs.mkdirSync(blocked, { recursive: true });
  h.engine.onSignal("tab1", { kind: "turn_started" });
  h.engine.onSignal("tab1", { kind: "result", isError: false });
  assert.equal(h.engine.watchingCount(), 1, "놓으면 아무도 다시 끝내 주지 않는다");
  // 디스크가 돌아오면 다음 신호에 정상적으로 끝난다
  fs.rmdirSync(blocked);
  h.engine.onSignal("tab1", { kind: "result", isError: false });
  assert.equal(h.store.runs("s1")[0].status, "completed");
  assert.equal(h.engine.watchingCount(), 0);
  fs.rmSync(h.dir, { recursive: true, force: true });
});
