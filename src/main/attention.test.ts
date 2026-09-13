import { test } from "node:test";
import assert from "node:assert/strict";
import { AttentionTracker } from "./attention";

const turn = (isError = false) =>
  ({
    type: "turn_result",
    ts: 1,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    costUsd: 0,
    durationMs: 0,
    numTurns: 1,
    modelUsage: {},
    isError,
  }) as const;

test("AttentionTracker: 권한 대기·미확인 완료·확인 시 해제·Dock 카운트", () => {
  let viewing = new Set<string>();
  const changes: Record<string, string>[] = [];
  const t = new AttentionTracker({
    isViewing: (id) => viewing.has(id),
    onChange: (m) => changes.push(m),
  });
  // 실행 중 → 권한 대기 → 다시 실행
  t.status("a", "running");
  assert.equal(t.count(), 0);
  t.status("a", "waiting_permission");
  assert.deepEqual(t.snapshot(), { a: "permission" });
  t.status("a", "running");
  assert.equal(t.count(), 0);
  // 보고 있지 않은 탭의 완료 → done, 보고 있으면 아무 표시 없음
  t.event("a", turn());
  assert.deepEqual(t.snapshot(), { a: "done" });
  viewing = new Set(["b"]);
  t.event("b", turn());
  assert.deepEqual(t.snapshot(), { a: "done" });
  // 오류는 error
  t.event("c", turn(true));
  assert.deepEqual(t.snapshot(), { a: "done", c: "error" });
  assert.equal(t.count(), 2);
  // 보면 지워진다. 권한 대기는 봐도 남는다.
  t.viewed("a");
  t.terminalPermission("d", true);
  t.viewed("d");
  assert.deepEqual(t.snapshot(), { c: "error", d: "permission" });
  t.terminalPermission("d", false);
  t.forget("c");
  assert.equal(t.count(), 0);
  // 같은 상태 반복은 onChange 를 다시 부르지 않는다
  const n = changes.length;
  t.forget("c");
  t.status("zzz", "idle");
  assert.equal(changes.length, n);
  // 어댑터가 직접 흘린 status 이벤트로도 권한 대기를 잡는다
  t.event("f", { type: "status", ts: 1, status: "waiting_permission" });
  assert.equal(t.snapshot().f, "permission");
  t.event("f", { type: "status", ts: 2, status: "running" });
  assert.equal(t.snapshot().f, undefined);
  // 새 턴이 시작되면 done 표시가 사라진다
  t.event("e", turn());
  t.status("e", "running");
  assert.equal(t.snapshot().e, undefined);
});
