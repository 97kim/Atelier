import { test } from "node:test";
import assert from "node:assert/strict";
import { nextAttentionTab } from "./attention-nav";

test("nextAttentionTab: 활성 탭 다음부터 순환, 후보 없으면 null, 자기 자신만 남으면 자신", () => {
  const ids = ["a", "b", "c", "d"];
  const att = { b: "done", d: "permission" } as const;
  assert.equal(nextAttentionTab(ids, att, "a"), "b");
  assert.equal(nextAttentionTab(ids, att, "b"), "d");
  assert.equal(nextAttentionTab(ids, att, "d"), "b"); // 끝에서 처음으로
  assert.equal(nextAttentionTab(ids, att, "b", -1), "d");
  assert.equal(nextAttentionTab(ids, att, null), "b");
  assert.equal(nextAttentionTab(ids, {}, "a"), null);
  assert.equal(nextAttentionTab(ids, { c: "error" }, "c"), "c");
  assert.equal(nextAttentionTab(ids, { zzz: "done" }, "a"), null); // 닫힌 탭은 후보가 아니다
});
