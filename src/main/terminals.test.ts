import { test } from "node:test";
import assert from "node:assert/strict";
import { TerminalManager } from "./terminals";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("TerminalManager: 셸을 띄워 입출력하고, 재오픈은 기존 셸에 붙고, close 하면 exit 가 온다", async () => {
  const data: string[] = [];
  const exits: number[] = [];
  const tm = new TerminalManager({ onData: (_id, d) => data.push(d), onExit: (_id, code) => exits.push(code) });
  const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME ?? "/tmp", SHELL: "/bin/sh" };

  const r = tm.open("t1", process.cwd(), env, 80, 24);
  assert.equal(r.ok, true, r.error);
  assert.equal(r.existing, false);
  assert.equal(r.shell, "/bin/sh");

  // 프롬프트가 뜨기 전에 보낸 입력은 셸 초기화(rc 파일)에 먹힐 수 있어 첫 출력 후 잠시 기다린다.
  for (let i = 0; i < 200 && data.length === 0; i++) await wait(50);
  await wait(500);
  assert.equal(tm.write("t1", "echo PTY_$((6*7))\n"), true);
  for (let i = 0; i < 200 && !data.join("").includes("PTY_42"); i++) await wait(50); // 로그인 셸 기동 대기
  assert.ok(data.join("").includes("PTY_42"), `출력에 PTY_42 가 없음: ${JSON.stringify(data.join(""))}`);

  const again = tm.open("t1", process.cwd(), env, 100, 30);
  assert.equal(again.existing, true);
  assert.equal(again.pid, r.pid);

  tm.close("t1");
  for (let i = 0; i < 100 && exits.length === 0; i++) await wait(50);
  assert.equal(exits.length, 1);
  assert.equal(tm.has("t1"), false);
  assert.equal(tm.write("t1", "x"), false);
});

test("TerminalManager: 없는 cwd 는 ok:false 로 알린다", () => {
  const tm = new TerminalManager({ onData: () => {}, onExit: () => {} });
  const r = tm.open("t2", "/nonexistent/dir/for/test", { PATH: "/usr/bin:/bin", SHELL: "/bin/sh" }, 80, 24);
  assert.equal(r.ok, false);
  assert.match(r.error ?? "", /작업 경로가 없습니다/);
  assert.equal(tm.has("t2"), false);
});
