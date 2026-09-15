import test from "node:test";
import assert from "node:assert/strict";
import { moveNextTo, neighborOf } from "@shared/reorder";

test("대상의 앞뒤로 옮긴다", () => {
  const ids = ["a", "b", "c", "d"];
  assert.deepEqual(moveNextTo(ids, "d", "b", false), ["a", "d", "b", "c"]);
  assert.deepEqual(moveNextTo(ids, "d", "b", true), ["a", "b", "d", "c"]);
  assert.deepEqual(moveNextTo(ids, "a", "d", true), ["b", "c", "d", "a"]);
  assert.deepEqual(moveNextTo(ids, "a", "b", false), ["a", "b", "c", "d"]);
});

test("같은 것·없는 것이면 그대로 둔다", () => {
  const ids = ["a", "b"];
  assert.deepEqual(moveNextTo(ids, "a", "a", true), ids);
  assert.deepEqual(moveNextTo(ids, "없음", "a", true), ids);
  assert.deepEqual(moveNextTo(ids, "a", "없음", true), ids);
  assert.deepEqual(moveNextTo([], "a", "b", true), []);
});

test("사이에 남의 항목이 섞여 있어도 바로 옆에 붙인다", () => {
  // 열린 탭 목록은 워크스페이스가 섞여 있다 — 그래도 보이는 순서는 의도대로 바뀐다
  assert.deepEqual(moveNextTo(["a1", "b1", "a2"], "a2", "a1", false), ["a2", "a1", "b1"]);
});

test("이웃 찾기 — 끝에서는 없다", () => {
  const ids = ["a", "b", "c"];
  assert.equal(neighborOf(ids, "b", "up"), "a");
  assert.equal(neighborOf(ids, "b", "down"), "c");
  assert.equal(neighborOf(ids, "a", "up"), null);
  assert.equal(neighborOf(ids, "c", "down"), null);
  assert.equal(neighborOf(ids, "없음", "up"), null);
});
