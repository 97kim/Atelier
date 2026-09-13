import { test } from "node:test";
import assert from "node:assert/strict";
import type { ThreadEvent } from "@openai/codex-sdk";
import { codexUsage, mapCodexEvent } from "./codex-events";

const ctx = { model: "gpt-5.3-codex", startedAt: 1000 };
const map = (e: ThreadEvent, ts = 1500) => mapCodexEvent(e, ts, ctx);

test("thread.started → session 이벤트", () => {
  assert.deepEqual(map({ type: "thread.started", thread_id: "th-1" }), [
    { type: "session", ts: 1500, sessionId: "th-1", provider: "codex", model: "gpt-5.3-codex" },
  ]);
});

test("agent_message 완료 → assistant_text (blockId = item id)", () => {
  assert.deepEqual(
    map({ type: "item.completed", item: { id: "m1", type: "agent_message", text: "안녕" } }),
    [{ type: "assistant_text", ts: 1500, blockId: "m1", text: "안녕" }],
  );
});

test("command_execution: started 는 tool_use 만, completed 는 tool_use + tool_result", () => {
  const started = map({
    type: "item.started",
    item: {
      id: "c1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "",
      status: "in_progress",
    },
  });
  assert.deepEqual(started, [
    { type: "tool_use", ts: 1500, toolUseId: "c1", name: "Bash", input: { command: "ls" } },
  ]);
  const done = map({
    type: "item.completed",
    item: {
      id: "c1",
      type: "command_execution",
      command: "ls",
      aggregated_output: "a\n",
      exit_code: 0,
      status: "completed",
    },
  });
  assert.equal(done.length, 2);
  assert.deepEqual(done[1], {
    type: "tool_result",
    ts: 1500,
    toolUseId: "c1",
    output: "a\n",
    isError: false,
  });
});

test("command_execution exit_code≠0 → isError", () => {
  const done = map({
    type: "item.completed",
    item: {
      id: "c2",
      type: "command_execution",
      command: "false",
      aggregated_output: "",
      exit_code: 1,
      status: "completed",
    },
  });
  assert.equal((done[1] as { isError: boolean }).isError, true);
});

test("file_change → ApplyPatch tool_use + 변경 목록 결과", () => {
  const out = map({
    type: "item.completed",
    item: {
      id: "f1",
      type: "file_change",
      changes: [
        { path: "a.ts", kind: "update" },
        { path: "b.ts", kind: "add" },
      ],
      status: "completed",
    },
  });
  assert.equal((out[0] as { name: string }).name, "ApplyPatch");
  assert.equal((out[1] as { output: string }).output, "update a.ts\nadd b.ts");
});

test("mcp_tool_call 성공/실패", () => {
  const ok = map({
    type: "item.completed",
    item: {
      id: "t1",
      type: "mcp_tool_call",
      server: "kop",
      tool: "list",
      arguments: { n: 1 },
      result: { content: [{ type: "text", text: "hi" }], structured_content: null },
      status: "completed",
    },
  });
  assert.deepEqual(ok[0], {
    type: "tool_use",
    ts: 1500,
    toolUseId: "t1",
    name: "kop:list",
    input: { n: 1 },
  });
  assert.deepEqual(ok[1], {
    type: "tool_result",
    ts: 1500,
    toolUseId: "t1",
    output: "hi",
    isError: false,
  });
  const fail = map({
    type: "item.completed",
    item: {
      id: "t2",
      type: "mcp_tool_call",
      server: "kop",
      tool: "run",
      arguments: {},
      error: { message: "boom" },
      status: "failed",
    },
  });
  assert.deepEqual(fail[1], {
    type: "tool_result",
    ts: 1500,
    toolUseId: "t2",
    output: "boom",
    isError: true,
  });
});

test("todo_list → TodoWrite, web_search → WebSearch", () => {
  const todo = map({
    type: "item.completed",
    item: { id: "d1", type: "todo_list", items: [{ text: "x", completed: false }] },
  });
  assert.equal((todo[0] as { name: string }).name, "TodoWrite");
  const ws = map({
    type: "item.completed",
    item: { id: "w1", type: "web_search", query: "codex" },
  });
  assert.equal((ws[0] as { name: string }).name, "WebSearch");
});

test("turn.completed → turn_result (캐시 분리, duration, cost 0)", () => {
  const out = map(
    {
      type: "turn.completed",
      usage: {
        input_tokens: 1000,
        cached_input_tokens: 800,
        cache_write_input_tokens: 50,
        output_tokens: 20,
        reasoning_output_tokens: 5,
      },
    },
    4000,
  );
  assert.deepEqual(out, [
    {
      type: "turn_result",
      ts: 4000,
      usage: { input: 200, output: 20, cacheRead: 800, cacheWrite: 50 },
      costUsd: 0,
      durationMs: 3000,
      numTurns: 1,
      modelUsage: {
        "gpt-5.3-codex": { input: 200, output: 20, cacheRead: 800, cacheWrite: 50, costUsd: 0 },
      },
      isError: false,
    },
  ]);
  assert.deepEqual(codexUsage(null), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
});

test("turn.failed / error → fatal error, error item → non-fatal", () => {
  const failed = map({ type: "turn.failed", error: { message: "x" } })[0] as { fatal?: boolean };
  assert.equal(failed.fatal, undefined);
  assert.equal((map({ type: "error", message: "y" })[0] as { message: string }).message, "y");
  const item = map({ type: "item.completed", item: { id: "e1", type: "error", message: "warn" } });
  assert.deepEqual(item, [{ type: "error", ts: 1500, message: "warn", fatal: false }]);
});

test("reasoning / turn.started / item.updated → no-op", () => {
  assert.deepEqual(
    map({ type: "item.completed", item: { id: "r", type: "reasoning", text: "생각" } }),
    [],
  );
  assert.deepEqual(map({ type: "turn.started" }), []);
  assert.deepEqual(
    map({ type: "item.updated", item: { id: "m", type: "agent_message", text: "p" } }),
    [],
  );
});
