import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrateKv, kvGet } from "./kv-store";
import { loadTerminalLayout, pruneTerminalState, removePane, saveTerminalLayout, saveTerminalOpen, selectPane } from "./terminal-panes";

const split = { dir: "row" as const, id: "t2" };

test("터미널 배치: 둘째 칸의 탭을 고르면 분할이 풀리고 그 터미널이 한 화면이 된다", () => {
  assert.deepEqual(selectPane({ active: "t1", split }, "t2"), { active: "t2", split: null });
  assert.deepEqual(selectPane({ active: "t1", split }, "t3"), { active: "t3", split }, "다른 탭은 첫 칸만 바뀐다");
  assert.deepEqual(selectPane({ active: "t1", split: null }, "t3"), { active: "t3", split: null });
});

test("터미널 배치: 나뉜 어느 쪽을 닫아도 남은 쪽이 한 화면을 차지한다", () => {
  const ids = ["t1", "t2", "t3"];
  assert.deepEqual(removePane({ active: "t1", split }, ids, "t2"), { active: "t1", split: null }, "둘째 칸을 닫으면");
  assert.deepEqual(removePane({ active: "t1", split }, ids, "t1"), { active: "t2", split: null }, "첫 칸을 닫으면");
  assert.deepEqual(removePane({ active: "t1", split }, ids, "t3"), { active: "t1", split }, "보이지 않는 탭을 닫으면 그대로");
  assert.deepEqual(removePane({ active: "t3", split: null }, ids, "t3"), { active: "t2", split: null }, "나뉘지 않았을 때는 마지막 탭으로");
  assert.deepEqual(removePane({ active: "t1", split: null }, ["t1"], "t1"), { active: null, split: null });
});

test("터미널 배치: 저장한 배치는 살아 있는 터미널에 맞춰 되살리고, 없는 터미널은 버린다", () => {
  hydrateKv({}, () => {});
  const bounds = { minHeight: 120, maxHeight: 600 };
  const fb = { active: "t1", height: 260 };
  assert.deepEqual(loadTerminalLayout("tab", ["t1"], fb, bounds), { active: "t1", split: null, height: 260, ratio: 50 }, "저장한 게 없으면 기본값");

  saveTerminalLayout("tab", { active: "t2", split: { dir: "col", id: "t1" }, height: 900, ratio: 5 });
  assert.deepEqual(
    loadTerminalLayout("tab", ["t1", "t2"], fb, bounds),
    { active: "t2", split: { dir: "col", id: "t1" }, height: 600, ratio: 15 },
    "높이·비율은 범위 안으로",
  );
  assert.deepEqual(
    loadTerminalLayout("tab", ["t2"], fb, bounds),
    { active: "t2", split: null, height: 600, ratio: 15 },
    "둘째 칸의 터미널이 죽었으면 분할만 버린다",
  );
  assert.deepEqual(loadTerminalLayout("tab", ["t1"], fb, bounds).active, "t1", "active 가 죽었으면 fallback");

  saveTerminalLayout("tab", { active: "t1", split: { dir: "row", id: "t1" }, height: 260, ratio: 50 });
  assert.equal(loadTerminalLayout("tab", ["t1"], fb, bounds).split, null, "같은 터미널을 두 칸에 두지 않는다");
});

test("터미널 배치: 닫힌 채팅 탭의 배치·열림 상태는 치운다", () => {
  hydrateKv({}, () => {});
  saveTerminalOpen("live", true);
  saveTerminalOpen("dead", true);
  saveTerminalLayout("dead", { active: "x", split: null, height: 200, ratio: 50 });
  pruneTerminalState(new Set(["live"]));
  assert.equal(kvGet("terminal.open.live"), "1");
  assert.equal(kvGet("terminal.open.dead"), null);
  assert.equal(kvGet("terminal.layout.dead"), null);
});

test("터미널 배치: 저장값이 객체가 아니면(null·배열·숫자·깨진 JSON) 기본 배치로 돌아간다", () => {
  const bounds = { minHeight: 120, maxHeight: 600 };
  const fb = { active: "t1", height: 260 };
  for (const raw of ["null", "[1,2]", "7", "{broken"]) {
    hydrateKv({ "terminal.layout.tab": raw }, () => {});
    assert.deepEqual(loadTerminalLayout("tab", ["t1"], fb, bounds), { active: "t1", split: null, height: 260, ratio: 50 }, raw);
  }
});
