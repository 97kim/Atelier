import { test } from "node:test";
import assert from "node:assert/strict";
import type { OrchRunState } from "@shared/orchestration";
import { cleanupState, createWorkerCleanup } from "./orch-cleanup";

function result(tabClosed: boolean, worktreeRemoved: boolean): OrchRunState[] {
  return [{ run: { id: "run" }, dispatches: [{ id: "dispatch", cleaned: { tabClosed, worktreeRemoved, at: 1 } }] }] as OrchRunState[];
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

test("cleanup: 실제 처리 결과 네 가지를 구분한다", () => {
  assert.equal(cleanupState({ tabClosed: true, worktreeRemoved: true, at: 1 }), "folder_and_tab");
  assert.equal(cleanupState({ tabClosed: false, worktreeRemoved: true, at: 1 }), "folder_only");
  assert.equal(cleanupState({ tabClosed: true, worktreeRemoved: false, at: 1 }), "tab_only");
  assert.equal(cleanupState({ tabClosed: false, worktreeRemoved: false, at: 1 }), "nothing_removed");
});

test("cleanup: 처리 응답을 기다린 뒤 해당 run/dispatch의 최신 결과를 조회한다", async () => {
  const removed = deferred<{ ok: true }>();
  let refreshed = false;
  const action = createWorkerCleanup({
    remove: async (runId, dispatchId) => {
      assert.equal(runId, "run");
      assert.equal(dispatchId, "dispatch");
      return removed.promise;
    },
    refresh: async () => { refreshed = true; return result(true, false); },
  });
  const pending = action.run("run", "dispatch");
  assert.equal(refreshed, false);
  removed.resolve({ ok: true });
  assert.deepEqual(await pending, { kind: "confirmed", state: "tab_only" });
});

test("cleanup: 이미 처리된 요청도 저장된 결과를 사용하고 중복 요청을 합친다", async () => {
  const refreshed = deferred<OrchRunState[]>();
  let requests = 0;
  const action = createWorkerCleanup({
    remove: async () => { requests++; return { ok: true }; },
    refresh: () => refreshed.promise,
  });
  const first = action.run("run", "dispatch");
  const duplicate = action.run("run", "dispatch");
  assert.equal(first, duplicate);
  assert.equal(action.isPending("run", "dispatch"), true);
  assert.equal(requests, 1);
  refreshed.resolve(result(false, false));
  assert.deepEqual(await first, { kind: "confirmed", state: "nothing_removed" });
  assert.equal(action.isPending("run", "dispatch"), false);
  assert.deepEqual(await action.run("run", "dispatch"), { kind: "confirmed", state: "nothing_removed" });
  assert.equal(requests, 2);
});

test("cleanup: 성공 뒤 조회가 실패해도 삭제 실패라고 하지 않는다", async () => {
  const action = createWorkerCleanup({
    remove: async () => ({ ok: true }),
    refresh: async () => { throw new Error("조회 연결 실패"); },
  });
  assert.deepEqual(await action.run("run", "dispatch"), { kind: "unconfirmed" });
});

test("cleanup: 다른 대상의 결과나 누락된 결과로 삭제를 단정하지 않는다", async () => {
  const withoutCleaned = [{ run: { id: "run" }, dispatches: [{ id: "dispatch" }] }] as OrchRunState[];
  for (const runs of [[], withoutCleaned, result(true, true)]) {
    const action = createWorkerCleanup({ remove: async () => ({ ok: true }), refresh: async () => runs });
    assert.deepEqual(await action.run("run", runs === withoutCleaned ? "dispatch" : "missing"), { kind: "unconfirmed" });
  }
});

test("cleanup: 처리 실패는 조회하지 않으며 잠금을 풀어 재시도할 수 있다", async () => {
  let calls = 0;
  let reads = 0;
  const action = createWorkerCleanup({
    remove: async () => {
      if (++calls === 1) return { ok: false, error: "실행 중" };
      if (calls === 2) throw new Error("요청 실패");
      return { ok: true };
    },
    refresh: async () => { reads++; return result(true, true); },
  });
  assert.deepEqual(await action.run("run", "dispatch"), { kind: "failed", error: "실행 중" });
  assert.equal(action.isPending("run", "dispatch"), false);
  assert.deepEqual(await action.run("run", "dispatch"), { kind: "failed", error: "요청 실패" });
  assert.equal(reads, 0);
  assert.deepEqual(await action.run("run", "dispatch"), { kind: "confirmed", state: "folder_and_tab" });
});
