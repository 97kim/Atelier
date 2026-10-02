import test from "node:test";
import assert from "node:assert/strict";
import { isToolActive, isToolFailed, isToolWaiting, toolState } from "./tool-state";

const b = (o: Partial<Parameters<typeof toolState>[0]>) => ({ name: "Bash", partial: false, ...o });

test("도구 카드 상태는 문구가 아니라 값으로 정한다", () => {
  assert.equal(toolState(b({ partial: true })), "partial");
  assert.equal(toolState(b({ partial: true, result: { output: "", isError: true } })), "failed");
  assert.equal(toolState(b({ permission: "pending" })), "waiting_permission");
  assert.equal(toolState(b({ name: "AskUserQuestion", permission: "pending" })), "waiting_answer");
  assert.equal(toolState(b({ permission: "denied" })), "denied");
  assert.equal(toolState(b({ name: "AskUserQuestion", permission: "denied" })), "skipped");
  assert.equal(toolState(b({ result: { output: "", isError: false } })), "done");
  assert.equal(toolState(b({ result: { output: "", isError: true } })), "failed");
  assert.equal(toolState(b({})), "running");
});

test("진행 중·대기·실패 묶음", () => {
  assert.deepEqual(["partial", "running", "waiting_permission", "waiting_answer"].map((s) => isToolActive(s as never)), [true, true, true, true]);
  assert.equal(isToolActive("done"), false);
  assert.equal(isToolWaiting("waiting_answer"), true);
  // 건너뛴 질문은 실패 색으로 칠하지 않는다(예전과 같다)
  assert.equal(isToolFailed("skipped"), false);
  assert.equal(isToolFailed("denied"), true);
});
