import type { OrchDispatch, OrchRunState } from "@shared/orchestration";

type Cleaned = NonNullable<OrchDispatch["cleaned"]>;
export type CleanupState = "folder_and_tab" | "folder_only" | "tab_only" | "nothing_removed";
export type CleanupOutcome =
  | { kind: "confirmed"; state: CleanupState }
  | { kind: "unconfirmed" }
  | { kind: "failed"; error: string };

export function cleanupState(cleaned: Cleaned): CleanupState {
  if (cleaned.worktreeRemoved) return cleaned.tabClosed ? "folder_and_tab" : "folder_only";
  return cleaned.tabClosed ? "tab_only" : "nothing_removed";
}

/** 성공 응답만으로 삭제를 단정하지 않고, 처리 후 저장된 결과를 새로 조회한다. */
export function createWorkerCleanup(deps: {
  remove: (runId: string, dispatchId: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  refresh: () => Promise<OrchRunState[]>;
}) {
  const pending = new Map<string, Promise<CleanupOutcome>>();
  const key = (runId: string, dispatchId: string) => JSON.stringify([runId, dispatchId]);
  const perform = async (runId: string, dispatchId: string): Promise<CleanupOutcome> => {
    try {
      const result = await deps.remove(runId, dispatchId);
      if (!result.ok) return { kind: "failed", error: result.error };
    } catch (error) {
      return { kind: "failed", error: error instanceof Error ? error.message : String(error) };
    }
    try {
      const runs = await deps.refresh();
      const cleaned = runs.find((run) => run.run.id === runId)?.dispatches.find((d) => d.id === dispatchId)?.cleaned;
      return cleaned ? { kind: "confirmed", state: cleanupState(cleaned) } : { kind: "unconfirmed" };
    } catch {
      // 요청은 성공했다. 결과 조회 실패를 삭제 실패로 표시하지 않는다.
      return { kind: "unconfirmed" };
    }
  };
  return {
    isPending: (runId: string, dispatchId: string) => pending.has(key(runId, dispatchId)),
    run(runId: string, dispatchId: string): Promise<CleanupOutcome> {
      const id = key(runId, dispatchId);
      const existing = pending.get(id);
      if (existing) return existing;
      const promise = perform(runId, dispatchId).finally(() => pending.delete(id));
      pending.set(id, promise);
      return promise;
    },
  };
}
