import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFileLogger, formatLine, LOG_FILE, rotateIfNeeded } from "./logger";

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "wb-log-"));
}

test("formatLine: ISO 시각 + 레벨 + Error 는 스택", () => {
  const line = formatLine("error", ["boom", new Error("x")], new Date(0));
  assert.ok(line.startsWith("1970-01-01T00:00:00.000Z ERROR boom Error: x"));
  assert.ok(line.endsWith("\n"));
});

test("파일에 append 되고 콘솔 패치 후에도 원래 콘솔이 호출된다", () => {
  const dir = tmpDir();
  const logger = createFileLogger(dir);
  const calls: unknown[][] = [];
  const orig = console.warn;
  console.warn = (...a: unknown[]) => calls.push(a);
  try {
    logger.patchConsole();
    console.warn("hello", { a: 1 });
  } finally {
    console.warn = orig;
    // patchConsole 이 log/error 도 바꿨으므로 원복 — 테스트 러너 출력이 파일로 새지 않게.
  }
  const text = fs.readFileSync(path.join(dir, LOG_FILE), "utf8");
  assert.match(text, /WARN  hello \{ a: 1 \}/);
  assert.equal(calls.length, 1);
});

test("크기 초과 시 main.log → main.1.log → main.2.log 회전, 최대 3개", () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, "main.log"), "old-1");
  assert.equal(rotateIfNeeded(dir, 1, 3), true);
  fs.writeFileSync(path.join(dir, "main.log"), "old-2");
  assert.equal(rotateIfNeeded(dir, 1, 3), true);
  fs.writeFileSync(path.join(dir, "main.log"), "old-3");
  assert.equal(rotateIfNeeded(dir, 1, 3), true);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ["main.1.log", "main.2.log"]);
  assert.equal(fs.readFileSync(path.join(dir, "main.1.log"), "utf8"), "old-3");
  assert.equal(fs.readFileSync(path.join(dir, "main.2.log"), "utf8"), "old-2");
});

test("작으면 회전하지 않고 파일이 없어도 에러 없음", () => {
  const dir = tmpDir();
  assert.equal(rotateIfNeeded(dir), false);
  fs.writeFileSync(path.join(dir, "main.log"), "tiny");
  assert.equal(rotateIfNeeded(dir), false);
});

test("write 가 maxBytes 를 넘기면 스스로 회전한다", () => {
  const dir = tmpDir();
  const logger = createFileLogger(dir, { maxBytes: 80, maxFiles: 2 });
  for (let i = 0; i < 5; i++) logger.write("info", ["x".repeat(30)]);
  const files = fs.readdirSync(dir).sort();
  assert.deepEqual(files, ["main.1.log", "main.log"]);
});
