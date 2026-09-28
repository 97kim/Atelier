import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrateKv } from "./kv-store";
import { closePane, loadSplit, openSplit, pruneSplit, saveSplit, syncActive } from "./split-view";

test("openSplit: 보던 탭은 왼쪽, 고른 탭은 오른쪽에 두고 오른쪽에 포커스", () => {
  assert.deepEqual(openSplit(null, "a", "b"), { left: "a", right: "b", focused: 1 });
  assert.equal(openSplit(null, "a", "a"), null, "같은 탭이면 나누지 않는다");
  assert.equal(openSplit(null, null, "b"), null);
  assert.deepEqual(openSplit({ left: "a", right: "b", focused: 1 }, "b", "a"), { left: "a", right: "b", focused: 0 }, "이미 칸에 있으면 그 칸으로 포커스만");
  assert.deepEqual(openSplit({ left: "a", right: "b", focused: 0 }, "a", "c"), { left: "a", right: "c", focused: 1 }, "다른 탭이면 새로 나눈다");
});

test("syncActive: 칸에 있는 탭이면 포커스만, 칸 밖이면 포커스된 칸을 바꾸고, 같아지면 푼다", () => {
  const s = { left: "a", right: "b", focused: 0 as const };
  assert.deepEqual(syncActive(s, "b"), { ...s, focused: 1 });
  assert.equal(syncActive(s, "a"), s, "바뀐 게 없으면 같은 객체");
  assert.deepEqual(syncActive(s, "c"), { left: "c", right: "b", focused: 0 }, "왼쪽에 포커스면 왼쪽을 바꾼다");
  assert.deepEqual(syncActive({ ...s, focused: 1 }, "c"), { left: "a", right: "c", focused: 1 });
  assert.equal(syncActive(null, "a"), null);
  assert.equal(syncActive(s, null), null, "활성 탭이 없으면 푼다");
});

test("pruneSplit: 한 칸의 탭이 닫히면 풀고 남은 칸의 탭을 돌려준다", () => {
  const s = { left: "a", right: "b", focused: 1 as const };
  assert.deepEqual(pruneSplit(s, ["a", "b", "c"]), { state: s });
  assert.deepEqual(pruneSplit(s, ["a", "c"]), { state: null, keep: "a" }, "오른쪽이 닫히면 왼쪽이 남는다(이웃 c 가 아니라)");
  assert.deepEqual(pruneSplit(s, ["b", "c"]), { state: null, keep: "b" });
  assert.deepEqual(pruneSplit(s, ["c"]), { state: null });
  assert.equal(closePane(s, 1), "a");
  assert.equal(closePane(s, 0), "b");
});

test("loadSplit·saveSplit: 저장했다 되살리고, 닫힌 탭이나 깨진 값이면 버리고, 지금 활성 탭을 따른다", () => {
  hydrateKv({}, () => {});
  saveSplit({ left: "a", right: "b", focused: 1 }, 63.4);
  assert.deepEqual(loadSplit(["a", "b"], "b"), { state: { left: "a", right: "b", focused: 1 }, ratio: 63 });
  assert.deepEqual(loadSplit(["a", "b"], "a").state, { left: "a", right: "b", focused: 0 }, "활성 탭이 왼쪽이면 왼쪽 포커스");
  assert.deepEqual(loadSplit(["a", "b", "c"], "c").state, { left: "a", right: "c", focused: 1 }, "활성 탭이 칸 밖이면 포커스 칸을 바꾼다");
  assert.equal(loadSplit(["a"], "a").state, null, "한쪽이 닫혔으면 버린다");
  saveSplit(null, 50);
  assert.equal(loadSplit(["a", "b"], "a").state, null);
  hydrateKv({ "chat.split": "{broken" }, () => {});
  assert.deepEqual(loadSplit(["a", "b"], "a"), { state: null, ratio: 50 });
  hydrateKv({ "chat.split": JSON.stringify({ left: "a", right: "b", focused: 0, ratio: 99 }) }, () => {});
  assert.equal(loadSplit(["a", "b"], "a").ratio, 80, "비율은 20~80");
});
