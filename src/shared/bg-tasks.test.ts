import test from "node:test";
import assert from "node:assert/strict";
import { parseLiveTasks, parseTaskFinished, taskLabel, taskSummary } from "@shared/bg-tasks";

test("살아 있는 작업 목록을 읽는다", () => {
  const r = parseLiveTasks([
    { task_id: "t1", task_type: "shell", description: "yarn package" },
    { task_id: "t2", task_type: "subagent", description: "조사" },
  ]);
  assert.deepEqual(r, [
    { id: "t1", type: "shell", description: "yarn package" },
    { id: "t2", type: "subagent", description: "조사" },
  ]);
});

test("살림용(ambient) 작업은 화면에 세지 않는다", () => {
  const r = parseLiveTasks([
    { task_id: "t1", task_type: "shell", description: "보여야 한다" },
    { task_id: "t2", task_type: "monitor", description: "살림", ambient: true },
  ]);
  assert.deepEqual(r.map((t) => t.id), ["t1"]);
});

test("모양이 틀린 항목은 버린다", () => {
  assert.deepEqual(parseLiveTasks(null), []);
  assert.deepEqual(parseLiveTasks("nope"), []);
  assert.deepEqual(parseLiveTasks([null, 3, {}, { task_id: "" }]), []);
  // 종류·설명이 없어도 id 만 있으면 "도는 일" 로는 셀 수 있다
  assert.deepEqual(parseLiveTasks([{ task_id: "t" }]), [{ id: "t", type: "", description: "" }]);
});

test("종류 이름은 아는 것만 우리말로, 모르는 것은 그대로", () => {
  assert.equal(taskLabel("shell"), "명령");
  // 실제로 오는 값은 원본 판별자 쪽이다(앱에서 관측: local_bash)
  assert.equal(taskLabel("local_bash"), "명령");
  assert.equal(taskLabel("local_agent"), "하위 에이전트");
  assert.equal(taskLabel("subagent"), "하위 에이전트");
  assert.equal(taskLabel("weird_new_type"), "weird_new_type");
  assert.equal(taskLabel(""), "작업");
});

test("설명은 한 줄로 줄인다", () => {
  assert.equal(taskSummary("  두 줄\n짜리  설명 "), "두 줄 짜리 설명");
  assert.equal(taskSummary("x".repeat(300)).length, 120);
});

test("끝났다는 알림을 읽는다", () => {
  assert.deepEqual(parseTaskFinished({ task_id: "t1", status: "completed", summary: "됐다" }), {
    id: "t1",
    status: "completed",
    summary: "됐다",
  });
  assert.equal(parseTaskFinished({ task_id: "t1", status: "failed", summary: "" })?.status, "failed");
  assert.equal(parseTaskFinished({ task_id: "t1", status: "stopped", summary: "" })?.status, "stopped");
  // 모르는 상태·살림용·id 없음은 버린다
  assert.equal(parseTaskFinished({ task_id: "t1", status: "running" }), null);
  assert.equal(parseTaskFinished({ task_id: "t1", status: "completed", ambient: true }), null);
  assert.equal(parseTaskFinished({ status: "completed" }), null);
  assert.equal(parseTaskFinished(null), null);
});
