import { test } from "node:test";
import assert from "node:assert/strict";
import { getCtxDismissed, setCtxDismissed, shouldShowCtxBanner } from "./ctx-dismiss";

test("shouldShowCtxBanner: 닫은 뒤 +5%p, 또는 warn→critical 승격 시 다시 보인다", () => {
  assert.equal(shouldShowCtxBanner(85, "warn", null), true);
  const d = { pct: 85, level: "warn" as const };
  assert.equal(shouldShowCtxBanner(86, "warn", d), false);
  assert.equal(shouldShowCtxBanner(90, "warn", d), true);
  assert.equal(shouldShowCtxBanner(95, "critical", d), true);
  // critical 에서 닫으면 100 에 붙어 있어도 +5 는 불가 → 더 안 뜬다 (80% 아래로 내려가야 초기화)
  const c = { pct: 97, level: "critical" as const };
  assert.equal(shouldShowCtxBanner(100, "critical", c), false);
  assert.equal(shouldShowCtxBanner(99, "critical", c), false);
});

test("get/setCtxDismissed: 탭별로 기억하고 null 로 지운다", () => {
  setCtxDismissed("t1", { pct: 88, level: "warn" });
  assert.deepEqual(getCtxDismissed("t1"), { pct: 88, level: "warn" });
  assert.equal(getCtxDismissed("t2"), null);
  setCtxDismissed("t1", null);
  assert.equal(getCtxDismissed("t1"), null);
});
