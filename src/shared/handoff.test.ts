import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "./chat-events";
import { buildHandoff, extractFilePaths, pendingTodos } from "./handoff";

let t = 0;
type NoTs<T> = T extends unknown ? Omit<T, "ts"> : never;
const ev = (e: NoTs<ChatEvent>) => ({ ...e, ts: ++t }) as ChatEvent;

test("요약: 사용자/어시스턴트 텍스트, 툴 한 줄, 파일·할 일 통계", () => {
  const h = buildHandoff(
    [
      ev({ type: "user_message", id: "u1", text: "버그 고쳐" }),
      ev({ type: "text_delta", blockId: "a:0", text: "확인 " }),
      ev({ type: "text_delta", blockId: "a:0", text: "중" }),
      ev({ type: "tool_use", toolUseId: "t1", name: "Edit", input: {}, partial: true }),
      ev({
        type: "tool_use",
        toolUseId: "t1",
        name: "Edit",
        input: { file_path: "/r/a.ts", old_string: "x", new_string: "y" },
      }),
      ev({ type: "tool_result", toolUseId: "t1", output: "ok", isError: false }),
      ev({
        type: "tool_use",
        toolUseId: "t2",
        name: "TodoWrite",
        input: {
          todos: [
            { content: "테스트", status: "pending" },
            { content: "마무리", status: "completed" },
          ],
        },
      }),
      ev({
        type: "turn_result",
        usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        costUsd: 0,
        durationMs: 1,
        numTurns: 1,
        modelUsage: {},
        isError: false,
      }),
    ],
    { cwd: "/r", fromProvider: "claude" },
  );
  assert.equal(h.stats.messages, 2);
  assert.equal(h.stats.files, 1);
  assert.equal(h.stats.pendingTasks, 1);
  assert.ok(h.stats.tokensEstimate > 0);
  assert.match(h.summary, /claude 에서 전환/);
  assert.match(h.summary, /작업 디렉토리: \/r/);
  assert.match(h.summary, /### 사용자\n버그 고쳐/);
  assert.match(h.summary, /### 어시스턴트\n확인 중/);
  assert.match(h.summary, /- 툴 Edit: \/r\/a\.ts/);
  assert.match(h.summary, /- \[ \] 테스트/);
  assert.doesNotMatch(h.summary, /마무리/);
  assert.equal(h.summary.split("### 어시스턴트").length - 1, 1);
});

test("maxChars 초과 시 최근 내용 우선 보존", () => {
  const events: ChatEvent[] = [];
  for (let i = 0; i < 50; i++) {
    events.push(ev({ type: "user_message", id: `u${i}`, text: `메시지 ${i} ${"x".repeat(200)}` }));
  }
  const h = buildHandoff(events, { maxChars: 3000 });
  assert.ok(h.summary.length <= 3000);
  assert.match(h.summary, /앞부분 생략/);
  assert.match(h.summary, /메시지 49/);
  assert.doesNotMatch(h.summary, /메시지 0 /);
});

test("extractFilePaths / pendingTodos 는 두 provider 의 입력 형태를 모두 안다", () => {
  assert.deepEqual(extractFilePaths({ changes: [{ path: "a" }, { path: "b" }] }), ["a", "b"]);
  assert.deepEqual(extractFilePaths({ notebook_path: "n.ipynb" }), ["n.ipynb"]);
  assert.deepEqual(
    pendingTodos({
      items: [
        { text: "x", completed: false },
        { text: "y", completed: true },
      ],
    }),
    ["x"],
  );
  assert.deepEqual(pendingTodos(null), []);
});
