import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ScheduleStore, RUN_HISTORY_MAX } from "./schedule-store";
import type { Run, RunStatus, Schedule } from "@shared/schedules";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "sched-"));
const sched = (id = "s1"): Schedule => ({
  id, name: "점검", cron: "30 9 * * *", timezone: "Asia/Seoul", prompt: "요약", provider: "claude",
  policy: "ask", target: { kind: "fresh", workspaceId: "w1", worktree: true },
  enabled: true, missedRunGraceMinutes: 120, createdAt: 0, activeSince: 0,
});
const run = (over: Partial<Run> = {}): Run => ({
  id: over.id ?? `r${Math.random()}`, scheduleId: "s1", scheduledFor: 1000, trigger: "scheduled",
  status: "pending", snapshot: { prompt: "요약", cron: "30 9 * * *", timezone: "Asia/Seoul", policy: "ask", provider: "claude", target: { kind: "fresh", workspaceId: "w1", worktree: true } },
  startedAt: null, endedAt: null, tabId: null, reason: null, ...over,
});

test("저장하고 다시 읽는다", () => {
  const dir = tmp();
  const a = new ScheduleStore(dir);
  a.upsertSchedule(sched());
  a.createRun(run({ id: "r1", status: "completed" }));
  const b = new ScheduleStore(dir);
  assert.equal(b.schedules().length, 1);
  assert.equal(b.runs("s1").length, 1);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("깨진 파일이어도 앱은 뜬다", () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, "schedules.json"), "{망가짐");
  const s = new ScheduleStore(dir);
  assert.deepEqual(s.schedules(), []);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("같은 예정 시각의 회차를 두 번 만들지 않게 물어볼 수 있다", () => {
  const dir = tmp();
  const s = new ScheduleStore(dir);
  s.createRun(run({ id: "r1", scheduledFor: 5000 }));
  assert.equal(s.hasRunFor("s1", 5000), true);
  assert.equal(s.hasRunFor("s1", 6000), false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("재시작 복구: 끝을 못 본 회차는 중단으로 — 성공으로 바꾸지 않는다", () => {
  const dir = tmp();
  const a = new ScheduleStore(dir);
  a.createRun(run({ id: "r1", status: "running", startedAt: 1 }));
  a.createRun(run({ id: "r2", status: "completed", scheduledFor: 900 }));
  const b = new ScheduleStore(dir);
  const stranded = b.reconcileOnStart("앱이 끝을 보기 전에 종료됐습니다.");
  assert.deepEqual(stranded.map((r) => r.id), ["r1"]);
  const after = b.runs("s1");
  assert.equal(after.find((r) => r.id === "r1")?.status, "interrupted");
  assert.equal(after.find((r) => r.id === "r2")?.status, "completed");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("같은 사유의 건너뜀은 합친다 — 행이 쌓이지 않는다", () => {
  const dir = tmp();
  const s = new ScheduleStore(dir);
  const skip = (at: number) =>
    s.recordSkip({
      scheduleId: "s1", scheduledFor: at, status: "skipped_overlap" as RunStatus, reason: "앞 회차가 아직 끝나지 않았습니다.",
      make: () => run({ scheduledFor: at, status: "skipped_overlap", reason: "앞 회차가 아직 끝나지 않았습니다.", endedAt: at }),
    });
  assert.equal(skip(1000).coalesced, false, "처음은 새로 만든다");
  assert.equal(skip(2000).coalesced, true, "같은 사유는 합친다");
  assert.equal(skip(3000).coalesced, true);
  assert.equal(s.runs("s1").length, 1);
  assert.equal(s.runs("s1")[0].scheduledFor, 3000, "마지막 시각으로 민다");

  // 사유가 달라지면 새 행
  s.recordSkip({ scheduleId: "s1", scheduledFor: 4000, status: "skipped_missed" as RunStatus, reason: "늦음", make: () => run({ scheduledFor: 4000, status: "skipped_missed", reason: "늦음" }) });
  assert.equal(s.runs("s1").length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("이력 상한을 넘겨도 끝나지 않은 회차는 남긴다", () => {
  const dir = tmp();
  const s = new ScheduleStore(dir);
  s.createRun(run({ id: "live", scheduledFor: 1, status: "running" }));
  for (let i = 0; i < RUN_HISTORY_MAX + 10; i += 1) s.createRun(run({ id: `done${i}`, scheduledFor: 100 + i, status: "completed" }));
  const all = s.runs("s1");
  assert.ok(all.length <= RUN_HISTORY_MAX + 1, `${all.length}`);
  assert.ok(all.some((r) => r.id === "live"), "진행 중인 회차는 살아남는다");
  assert.equal(all.some((r) => r.id === "done0"), false, "가장 오래된 완료는 버린다");
  fs.rmSync(dir, { recursive: true, force: true });
});

test("예약을 지우면 그 회차도 같이 사라진다", () => {
  const dir = tmp();
  const s = new ScheduleStore(dir);
  s.upsertSchedule(sched());
  s.createRun(run({ id: "r1" }));
  s.removeSchedule("s1");
  assert.deepEqual(s.schedules(), []);
  assert.deepEqual(s.runs("s1"), []);
  fs.rmSync(dir, { recursive: true, force: true });
});
