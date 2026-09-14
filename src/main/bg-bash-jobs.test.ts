import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { BashJobWatcher } from "./bg-bash-jobs";
import type { BackgroundJobDto } from "@shared/background-jobs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "bgbash-"));
const startText = (id: string, file: string) =>
  `Command running in background with ID: ${id}. Output is being written to: ${file}. You will be notified when it completes.`;

function harness() {
  const changed: BackgroundJobDto[][] = [];
  const finished: BackgroundJobDto[] = [];
  const w = new BashJobWatcher({ onChanged: (j) => changed.push(j), onFinished: (j) => finished.push(j) });
  return { w, changed, finished };
}

test("백그라운드 명령을 등록하고, 끝 표시가 붙으면 끝난 것으로 본다", async () => {
  const dir = tmp();
  const file = path.join(dir, "abc.output");
  fs.writeFileSync(file, "빌드 중\n");
  const { w, changed, finished } = harness();

  w.noteToolUse("t1", "Bash", { command: "yarn package", run_in_background: true });
  assert.equal(w.hasPending("t1"), true);
  w.noteToolResult("t1", startText("abc", file), "sess-1", "/repo");

  assert.deepEqual(w.current().map((j) => j.id), ["abc"]);
  assert.equal(w.current()[0].summary, "yarn package");
  assert.equal(w.current()[0].sessionId, "sess-1");
  assert.equal(changed.length, 1);

  // 아직 도는 중 — 목록에 남아 있다
  await new Promise((r) => setTimeout(r, 2400));
  assert.equal(w.current().length, 1);
  assert.equal(finished.length, 0);

  fs.appendFileSync(file, "Done in 30.10s.\n\n[exited with code 0]\n");
  await new Promise((r) => setTimeout(r, 2400));
  assert.equal(w.current().length, 0);
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, "completed");
  assert.equal(finished[0].completedAt !== null, true);
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("0 이 아닌 코드로 끝나면 실패로 본다", async () => {
  const dir = tmp();
  const file = path.join(dir, "err.output");
  fs.writeFileSync(file, "no such file\n[exited with code 127]\n");
  const { w, finished } = harness();
  w.noteToolUse("t2", "Bash", { command: "nope", run_in_background: true });
  w.noteToolResult("t2", startText("err", file), "sess-1", "/repo");
  await new Promise((r) => setTimeout(r, 2400));
  assert.equal(finished.length, 1);
  assert.equal(finished[0].status, "failed");
  w.stop();
  fs.rmSync(dir, { recursive: true, force: true });
});

test("백그라운드가 아니거나 이을 대화가 없으면 등록하지 않는다", () => {
  const { w, changed } = harness();
  // 앞에서 돌던 명령이 아니다
  w.noteToolResult("없는id", startText("x", "/tmp/x.output"), "sess-1", "/repo");
  // 백그라운드가 아닌 Bash
  w.noteToolUse("t3", "Bash", { command: "ls", run_in_background: false });
  assert.equal(w.hasPending("t3"), false);
  // 세션 id 를 모르면 보여 줄 곳이 없다
  w.noteToolUse("t4", "Bash", { command: "sleep 1", run_in_background: true });
  w.noteToolResult("t4", startText("y", "/tmp/y.output"), null, "/repo");
  // 백그라운드로 넘어가지 않은 결과(문구 없음)
  w.noteToolUse("t5", "Bash", { command: "sleep 1", run_in_background: true });
  w.noteToolResult("t5", "권한이 거부되었습니다", "sess-1", "/repo");

  assert.deepEqual(w.current(), []);
  assert.equal(changed.length, 0);
  w.stop();
});

test("출력 파일이 아직 없어도 도는 중으로 본다", async () => {
  const { w, finished } = harness();
  w.noteToolUse("t6", "Bash", { command: "sleep 5", run_in_background: true });
  w.noteToolResult("t6", startText("ghost", "/tmp/없는-파일-abc.output"), "sess-1", "/repo");
  await new Promise((r) => setTimeout(r, 2400));
  assert.equal(w.current().length, 1);
  assert.equal(finished.length, 0);
  w.stop();
});
