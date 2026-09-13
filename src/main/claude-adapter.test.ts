import { test } from "node:test";
import assert from "node:assert/strict";
import { InputQueue, liveClaudeSessions, closeClaudeSession } from "./claude-adapter";

test("InputQueue: 넣은 순서대로 흘리고, 비면 기다리며, 닫으면 끝난다", async () => {
  const q = new InputQueue();
  const it = q.iterate();
  const msg = (t: string) => ({ type: "user", parent_tool_use_id: null, message: { role: "user", content: t } }) as never;
  q.push(msg("a"));
  q.push(msg("b"));
  assert.equal(((await it.next()).value as { message: { content: string } }).message.content, "a");
  assert.equal(((await it.next()).value as { message: { content: string } }).message.content, "b");
  // 비어 있으면 다음 push 까지 기다린다
  const pending = it.next();
  let settled = false;
  void pending.then(() => (settled = true));
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(settled, false);
  q.push(msg("c"));
  assert.equal(((await pending).value as { message: { content: string } }).message.content, "c");
  q.close();
  assert.equal((await it.next()).done, true);
  q.push(msg("late"));
  assert.equal((await it.next()).done, true, "닫힌 뒤의 push 는 버린다");
  // 세션 풀은 비어 있고, 없는 키 닫기는 무해
  assert.deepEqual(liveClaudeSessions(), []);
  closeClaudeSession("nope");
});
