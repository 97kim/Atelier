import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BackgroundJobWatcher } from "./background-jobs";
import { jobRunningLabel, mergeJobs, parseBackgroundJob, type BackgroundJobDto } from "@shared/background-jobs";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

const job = (over: Record<string, unknown> = {}) => ({
  id: "task-1",
  sessionId: "sess-a",
  kindLabel: "rescue",
  title: "Codex Task",
  status: "running",
  summary: "브라우저를  올려\n달라",
  createdAt: "2026-09-13T00:00:00.000Z",
  ...over,
});

test("parseBackgroundJob: 읽히는 것만 쓰고, 모르는 형식은 버린다", () => {
  const ok = parseBackgroundJob(job(), "/r/state.json");
  assert.equal(ok?.id, "task-1");
  assert.equal(ok?.label, "rescue");
  assert.equal(ok?.status, "running");
  assert.equal(ok?.summary, "브라우저를 올려 달라", "요약의 줄바꿈·연속 공백은 한 칸으로");
  assert.equal(ok?.startedAt, Date.parse("2026-09-13T00:00:00.000Z"));
  assert.equal(ok?.completedAt, null);

  assert.equal(parseBackgroundJob(null, "/r"), null);
  assert.equal(parseBackgroundJob(job({ id: "" }), "/r"), null, "id 없으면 버린다");
  assert.equal(parseBackgroundJob(job({ sessionId: undefined }), "/r"), null, "세션을 모르면 탭에 못 이으므로 버린다");
  assert.equal(parseBackgroundJob(job({ status: "weird" }), "/r"), null, "모르는 상태는 버린다");
  assert.equal(parseBackgroundJob(job({ createdAt: "nope" }), "/r"), null, "시각이 없으면 버린다");
  // kindLabel 이 없으면 kind 로, 그것도 없으면 기본 이름
  assert.equal(parseBackgroundJob(job({ kindLabel: undefined, kind: "review" }), "/r")?.label, "review");
  assert.equal(parseBackgroundJob(job({ kindLabel: undefined, kind: undefined }), "/r")?.label, "작업");
});

test("mergeJobs: 같은 저장소의 같은 id 는 하나로, 시작 순으로", () => {
  const a = parseBackgroundJob(job({ id: "a", createdAt: "2026-09-13T00:00:02.000Z" }), "/r")!;
  const b = parseBackgroundJob(job({ id: "b", createdAt: "2026-09-13T00:00:01.000Z" }), "/r")!;
  const aDup = parseBackgroundJob(job({ id: "a", status: "completed", createdAt: "2026-09-13T00:00:02.000Z" }), "/r")!;
  const bOther = parseBackgroundJob(job({ id: "b", createdAt: "2026-09-13T00:00:01.000Z" }), "/other")!;
  const out = mergeJobs([a, b, aDup, bOther]);
  assert.deepEqual(
    out.map((j) => `${j.root}|${j.id}|${j.status}`),
    ["/r|b|running", "/other|b|running", "/r|a|completed"],
  );
});

test("jobRunningLabel: 분·초", () => {
  const j = { label: "rescue", startedAt: 1000 } as BackgroundJobDto;
  assert.equal(jobRunningLabel(j, 1000 + 45_000), "rescue · 45초 경과");
  assert.equal(jobRunningLabel(j, 1000 + 192_000), "rescue · 3분 12초 경과");
  assert.equal(jobRunningLabel(j, 0), "rescue · 0초 경과", "시계가 뒤로 가도 음수는 안 나온다");
});

test("BackgroundJobWatcher: 시작 때 이미 끝난 작업은 알리지 않고, 돌던 것이 끝나면 알린다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-jobs-"));
  const dir = join(root, "codex-plugin", "state", "repo-1");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "state.json");
  const write = (jobs: unknown[]) => writeFileSync(file, JSON.stringify({ version: 1, jobs }));

  // 앱을 켤 때 이미 끝나 있던 작업 + 도는 작업 하나
  write([job({ id: "old", status: "completed", completedAt: "2026-09-13T00:01:00.000Z" }), job({ id: "live" })]);
  const changed: BackgroundJobDto[][] = [];
  const finished: BackgroundJobDto[] = [];
  const w = new BackgroundJobWatcher({ onChanged: (j) => changed.push(j), onFinished: (j) => finished.push(j) }, root);
  await w.start();
  assert.equal(finished.length, 0, "기준선 읽기는 알림을 내지 않는다");
  assert.deepEqual(
    w.current().map((j) => j.id),
    ["live"],
    "도는 것만 current 에",
  );

  // 돌던 것이 끝난다
  write([job({ id: "old", status: "completed", completedAt: "2026-09-13T00:01:00.000Z" }), job({ id: "live", status: "completed", completedAt: "2026-09-13T00:02:00.000Z" })]);
  for (let i = 0; i < 40 && finished.length === 0; i++) await wait(100);
  assert.equal(finished.length, 1, "끝난 작업을 한 번 알린다");
  assert.equal(finished[0].id, "live");
  assert.deepEqual(w.current(), [], "끝났으면 도는 목록에서 빠진다");
  assert.ok(changed.length >= 1, "목록 변화도 알린다");

  // 한 번 알린 것을 다시 알리지 않는다
  write([job({ id: "live", status: "completed", completedAt: "2026-09-13T00:02:00.000Z" })]);
  await wait(700);
  assert.equal(finished.length, 1);

  w.stop();
  rmSync(root, { recursive: true, force: true });
});

test("BackgroundJobWatcher: 시작 때 없던 디렉토리에 나중에 생긴 작업도 잡는다", async () => {
  // 감시자는 없는 디렉토리에 못 붙는다 — 주기적으로 다시 읽지 않으면 영영 못 본다(e2e 에서 실제로 놓쳤던 경우).
  const root = join(mkdtempSync(join(tmpdir(), "wb-jobs3-")), "아직-없음");
  const seen: BackgroundJobDto[][] = [];
  const w = new BackgroundJobWatcher({ onChanged: (j) => seen.push(j), onFinished: () => {} }, root);
  await w.start();
  assert.deepEqual(w.current(), [], "없는 동안은 빈 목록");

  const dir = join(root, "plugin", "state", "repo");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), JSON.stringify({ jobs: [job({ id: "late" })] }));
  for (let i = 0; i < 100 && w.current().length === 0; i++) await wait(100);
  assert.deepEqual(
    w.current().map((j) => j.id),
    ["late"],
    "나중에 생긴 작업도 잡아야 한다",
  );
  assert.ok(seen.length >= 1);
  w.stop();
  rmSync(root, { recursive: true, force: true });
});

test("BackgroundJobWatcher: 깨진 JSON·없는 디렉토리에도 죽지 않는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-jobs2-"));
  const dir = join(root, "p", "state", "r");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "state.json"), '{"jobs": [{"id": "x"');
  const w = new BackgroundJobWatcher({ onChanged: () => {}, onFinished: () => {} }, root);
  await w.start();
  assert.deepEqual(w.current(), []);
  w.stop();

  const missing = new BackgroundJobWatcher({ onChanged: () => {}, onFinished: () => {} }, join(root, "없음"));
  await missing.start();
  assert.deepEqual(missing.current(), []);
  missing.stop();
  rmSync(root, { recursive: true, force: true });
});
