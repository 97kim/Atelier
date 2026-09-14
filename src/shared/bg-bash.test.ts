import test from "node:test";
import assert from "node:assert/strict";
import { backgroundBashCommand, bashJobSummary, parseBashBackgroundStart, parseBashExitCode } from "@shared/bg-bash";

// 실제로 받은 문구 그대로. 여기가 깨지면 표시가 안 뜬다.
const REAL =
  'Command running in background with ID: b0n6xi6ny. Output is being written to: /private/tmp/claude-501/-Users-kyungjung-kim-ax-atelier/34dfa212-41ea-4a2f-b631-5d35f2406633/tasks/b0n6xi6ny.output. You will be notified when it completes.';

test("시작 문구에서 작업 id 와 출력 파일을 읽는다", () => {
  const r = parseBashBackgroundStart(REAL);
  assert.equal(r?.id, "b0n6xi6ny");
  assert.equal(r?.file.endsWith("/tasks/b0n6xi6ny.output"), true);
  // 경로 뒤의 마침표까지 끌고 오면 파일을 못 찾는다
  assert.equal(r?.file.endsWith(".output"), true);
});

test("백그라운드가 아닌 결과는 null", () => {
  assert.equal(parseBashBackgroundStart("total 12\ndrwxr-xr-x  3 me  staff  96 Sep 14 17:40 ."), null);
  assert.equal(parseBashBackgroundStart(""), null);
});

test("출력 꼬리에서 끝난 코드를 읽는다", () => {
  assert.equal(parseBashExitCode("Done in 30.10s.\n\n[exited with code 0]\n"), 0);
  assert.equal(parseBashExitCode("error\n[exited with code 1]"), 1);
  // 아직 도는 중
  assert.equal(parseBashExitCode("building target=DMG arch=arm64\n"), null);
  // 출력 중간에 같은 모양의 글자가 있어도 끝이 아니면 끝난 게 아니다
  assert.equal(parseBashExitCode("[exited with code 0]\n계속 찍힌다\n"), null);
});

test("백그라운드 Bash 만 가려낸다", () => {
  assert.equal(backgroundBashCommand("Bash", { command: "yarn package", run_in_background: true }), "yarn package");
  assert.equal(backgroundBashCommand("Bash", { command: "ls", run_in_background: false }), null);
  assert.equal(backgroundBashCommand("Bash", { command: "ls" }), null);
  assert.equal(backgroundBashCommand("Read", { run_in_background: true }), null);
  assert.equal(backgroundBashCommand("Bash", null), null);
  // 명령을 못 읽어도 백그라운드인 것은 맞다 — 빈 문자열로 둔다
  assert.equal(backgroundBashCommand("Bash", { run_in_background: true }), "");
});

test("목록에 쓸 한 줄로 줄인다", () => {
  assert.equal(bashJobSummary("  yarn   package\n && echo 끝 "), "yarn package && echo 끝");
  assert.equal(bashJobSummary("x".repeat(200)).length, 120);
  assert.equal(bashJobSummary("x".repeat(200)).endsWith("…"), true);
});
