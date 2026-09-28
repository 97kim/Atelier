// 오케스트레이션 패널(오버레이): Run 목록 · Task/워커 · 인박스. 사람이 여기서 워커 질문에 답하고, 후속 지시를 보내고, 워커를 정리한다.
import { usePaneFocusRef } from "../pane-focus";
// 화면을 연 것만으로 코디네이터 Delivery 를 ack 하지 않는다(코디네이터 탭의 check 가 소비한다).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { OrchDispatch, OrchMessage, OrchRunState, OrchTaskStatus } from "@shared/orchestration";
import { attention, runSummary, taskBlockers, taskWaves } from "@shared/orchestration";
import { PROVIDER_NAME } from "@shared/fanout";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { cleanupState, createWorkerCleanup, type CleanupState } from "../orch-cleanup";

const MSG_LABEL: Record<OrchMessage["type"], [string, string]> = {
  question: ["질문", "text-warn"],
  reply: ["답", "text-muted"],
  escalation: ["에스컬레이션", "text-err"],
  worker_done: ["완료 보고", "text-ok"],
  followup: ["후속 지시", "text-accent"],
  note: ["앱 통지", "text-muted"],
};

const DISPATCH_LABEL: Record<OrchDispatch["status"], string> = {
  starting: "시작 중",
  live: "실행 중",
  reported: "결과 보고됨 · 실행 종료 대기",
  settled: "결과 보고·실행 종료 확인",
  abandoned: "포기됨",
  failed_to_start: "시작 실패",
};

const TASK_LABEL: Record<OrchTaskStatus, string> = {
  pending: "대기 중", running: "진행 중", succeeded: "성공", failed: "실패", abandoned: "포기",
};
const EXECUTION_LABEL: Record<OrchDispatch["execution"]["state"], string> = {
  queued: "실행 순서 대기", running: "실행 중", waiting_permission: "승인 대기", waiting_reply: "답변 대기",
  limit_wait: "사용 한도 대기", idle: "대기 중", error: "오류", unknown: "상태 확인 필요",
};
const OWNERSHIP_LABEL: Record<OrchDispatch["ownership"], string> = {
  supervised: "관리 중", retained: "삭제 방지됨", released: "관리 해제됨",
};

const CLEANUP_LABEL: Record<CleanupState, string> = {
  folder_and_tab: "worktree 삭제·탭 닫힘 확인",
  folder_only: "worktree 삭제 확인 · 탭은 닫지 않음",
  tab_only: "탭 닫힘 확인 · worktree는 삭제하지 않음",
  nothing_removed: "삭제하거나 닫은 대상 없음",
};

const CLEANUP_MESSAGE: Record<CleanupState, string> = {
  folder_and_tab: "처리 기록에서 worktree 삭제와 탭 닫기가 완료된 것을 확인했습니다.",
  folder_only: "처리 기록에서 worktree 삭제를 확인했습니다. 탭은 닫지 않았습니다.",
  tab_only: "처리 기록에서 탭 닫기를 확인했습니다. worktree는 삭제하지 않았습니다.",
  nothing_removed: "처리 기록에 삭제한 worktree나 닫은 탭이 없습니다.",
};

function fmtActor(a: OrchMessage["from"]): string {
  return a.kind === "user" ? "사람" : a.kind === "app" ? "앱" : a.kind === "tab" ? "코디네이터" : "워커";
}

export function OrchestrationPanel({ initialRunId, onClose }: { initialRunId: string | null; onClose: () => void }) {
  const [runs, setRuns] = useState<OrchRunState[]>([]);
  const [selected, setSelected] = useState<string | null>(initialRunId);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [followup, setFollowup] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [cleaning, setCleaning] = useState<Set<string>>(() => new Set());
  const loadVersion = useRef(0);
  const mounted = useRef(true);
  const messageTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const showMessage = useCallback((message: { ok: boolean; text: string }) => {
    if (!mounted.current) return;
    if (messageTimer.current) clearTimeout(messageTimer.current);
    setMsg(message);
    messageTimer.current = setTimeout(() => setMsg(null), 6000);
  }, []);
  const refresh = useCallback(async () => {
    const version = ++loadVersion.current;
    const next = await window.workbench.orch.list();
    if (mounted.current && version === loadVersion.current) setRuns(next);
    return next;
  }, []);
  const load = useCallback(() => {
    const version = loadVersion.current + 1;
    void refresh().catch(() => {
      if (version === loadVersion.current) showMessage({ ok: false, text: "작업 상태를 불러오지 못했습니다. 다시 확인해 주세요." });
    });
  }, [refresh, showMessage]);
  const cleanupAction = useMemo(() => createWorkerCleanup({
    remove: (runId, dispatchId) => window.workbench.orch.worker(runId, dispatchId, "cleanup"),
    refresh,
  }), [refresh]);
  useEffect(() => {
    mounted.current = true;
    load();
    const unsubscribe = window.workbench.orch.onChanged(load);
    return () => {
      mounted.current = false;
      loadVersion.current++;
      if (messageTimer.current) clearTimeout(messageTimer.current);
      unsubscribe();
    };
  }, [load]);
  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const run = useMemo(() => runs.find((r) => r.run.id === (selected ?? runs[0]?.run.id)) ?? null, [runs, selected]);
  const act = async (p: Promise<{ ok: true } | { ok: false; error: string }>, okText: string) => {
    const r = await p;
    showMessage(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error });
  };
  const cleanup = async (runId: string, dispatchId: string) => {
    if (cleanupAction.isPending(runId, dispatchId)) return;
    setCleaning((current) => new Set(current).add(dispatchId));
    const outcome = await cleanupAction.run(runId, dispatchId);
    if (!mounted.current) return;
    setCleaning((current) => { const next = new Set(current); next.delete(dispatchId); return next; });
    showMessage(outcome.kind === "confirmed"
      ? { ok: true, text: CLEANUP_MESSAGE[outcome.state] }
      : outcome.kind === "failed"
        ? { ok: false, text: outcome.error }
        : { ok: false, text: "처리 요청은 완료됐지만 결과를 확인하지 못했습니다. 작업 상태를 다시 확인해 주세요." });
  };
  const a = run ? attention(run) : null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay/60 p-5" onClick={onClose} data-orch-panel>
      <div className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Icon name="list" size={15} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">오케스트레이션</div>
            <div className="mt-0.5 text-[10.5px] text-muted">Run에 속한 Task와 워커의 진행 상황 및 결과를 확인합니다. 인박스의 질문에 답하고, 워커에 추가 지시를 보낼 수 있습니다.</div>
          </div>
          {msg && (
            <span className={`text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`} data-orch-msg={msg.ok ? "ok" : "error"}>
              {msg.text}
            </span>
          )}
          <button onClick={load} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title="다시 읽기">
            <Icon name="refresh" size={13} />
          </button>
          <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title="닫기 (esc)">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[260px] shrink-0 flex-col overflow-y-auto border-r border-line" data-orch-runs>
            {runs.length === 0 && <div className="px-3 py-3 text-[11.5px] text-muted">Run이 없습니다. 터미널에서 만들 수 있습니다: atelier orch run-create --objective "…"</div>}
            {runs.map((r) => {
              const at = attention(r);
              return (
                <button key={r.run.id} onClick={() => setSelected(r.run.id)} className={`flex flex-col gap-0.5 border-b border-line px-3 py-2 text-left ${run?.run.id === r.run.id ? "bg-accent-tint" : "hover:bg-panel-2"}`} data-orch-run={r.run.id}>
                  <span className="truncate text-[12px]">{r.run.objective}</span>
                  <span className="mono text-[10px] text-muted-2">
                    {r.run.id} · {r.run.coordinator.kind === "tab" ? "코디네이터" : "사람 코디네이터"} · {r.run.status === "closed" ? "닫힘" : runSummary(r)}
                    {at.questions.length > 0 ? ` · 질문 ${at.questions.length}` : ""}
                  </span>
                </button>
              );
            })}
          </div>
          {run ? (
            <div className="flex min-w-0 flex-1 flex-col overflow-y-auto">
              <div className="flex items-center gap-2 border-b border-line px-4 py-2">
                <span className="text-[13px] font-medium">{run.run.objective}</span>
                <span className="mono text-[10.5px] text-muted-2">{run.run.id}</span>
                <span className="flex-1" />
                {run.run.coordinator.kind === "tab" && run.run.status === "active" && (
                  <button onClick={() => void act(window.workbench.orch.takeover(run.run.id), "사람 코디네이터로 작업을 인수했습니다.")} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title="코디네이터 대신 직접 질문에 답하고 작업 진행을 관리합니다" data-orch-takeover>
                    코디네이터 인수
                  </button>
                )}
                {run.run.status === "active" && (
                  <button onClick={() => void act(window.workbench.orch.close(run.run.id), "Run을 닫았습니다.")} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-close>
                    Run 닫기
                  </button>
                )}
              </div>
              <div className="border-b border-line px-4 py-2">
                <div className="label mb-1 text-muted">Task · 워커</div>
                {(() => { const waves = taskWaves(run); const maxWave = Math.max(0, ...waves.values()); return run.tasks.map((t) => { const wave = waves.get(t.id) ?? 1;
                  const ds = run.dispatches.filter((d) => d.taskId === t.id);
                  const b = taskBlockers(run, t);
                  const gates = run.gates.filter((g) => g.taskId === t.id);
                  return (
                    <div key={t.id} className="mb-1.5 rounded-md border border-line" data-orch-panel-task={t.id}>
                      <div className="flex items-center gap-2 px-2.5 py-1.5">
                        <span className="mono text-[11px] text-muted">{t.seq}</span>
                        {maxWave > 1 && <span className="mono rounded bg-inset px-1 text-[10px] text-muted-2" title="앞선 작업이 끝나야 시작할 수 있는 실행 단계" data-orch-wave={wave}>W{wave}</span>}
                        <span className="min-w-0 flex-1 truncate text-[12px]" title={t.spec}>
                          {t.spec.split("\n")[0]}
                        </span>
                        {t.deps.length > 0 && (
                          <span className="mono text-[10px] text-muted-2" title={`의존: ${t.deps.join(", ")}`}>
                            ← {t.deps.map((id) => run.tasks.find((x) => x.id === id)?.seq ?? "?").join(",")}
                          </span>
                        )}
                        {t.status === "pending" && b.unmetDeps.length > 0 && <span className="label text-muted-2">선행 Task 대기</span>}
                        {t.status === "pending" && b.pendingGates.length > 0 && <span className="label text-warn">게이트 결정 대기</span>}
                        <span className={`label ${t.status === "succeeded" ? "text-ok" : t.status === "failed" || t.status === "abandoned" ? "text-err" : t.status === "running" ? "text-accent" : "text-muted-2"}`}>{TASK_LABEL[t.status]}</span>
                      </div>
                      {gates.map((g) => (
                        <div key={g.id} className="flex flex-wrap items-center gap-2 border-t border-line bg-warn-bg/40 px-2.5 py-1 text-[11.5px]" data-orch-gate={g.id} data-orch-gate-resolved={g.resolution ? "true" : "false"}>
                          <span className="label text-warn">게이트</span>
                          <span className="min-w-0 flex-1">{g.question}</span>
                          {g.resolution ? (
                            <span className="text-ok">결정: {g.resolution.choice}</span>
                          ) : (
                            g.options.map((o) => (
                              <button key={o} onClick={() => void act(window.workbench.orch.gate(run.run.id, g.id, o), `게이트를 "${o}"(으)로 결정했습니다.`)} className="rounded-md border border-warn/40 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/10" data-orch-gate-option={o}>
                                {o}
                              </button>
                            ))
                          )}
                        </div>
                      ))}
                      {ds.map((d) => (
                        <div key={d.id} className="flex flex-wrap items-center gap-2 border-t border-line px-2.5 py-1 text-[11.5px]" data-orch-dispatch={d.id} data-orch-dispatch-status={d.status}>
                          <ProviderLogo provider={d.provider} size={13} />
                          <span className="text-muted">
                            {PROVIDER_NAME[d.provider]} · 시도 {d.attempt} · {DISPATCH_LABEL[d.status]}
                            {d.status === "live" ? ` (${EXECUTION_LABEL[d.execution.state]})` : ""} · {OWNERSHIP_LABEL[d.ownership]}
                          </span>
                          {d.worktree && <span className="mono text-[10px] text-muted-2">worktree</span>}
                          <span className="flex-1" />
                          {d.tabId && (
                            <button onClick={() => void window.workbench.workspaces.activateTab(d.tabId)} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg">
                              탭
                            </button>
                          )}
                          {(d.status === "live" || d.status === "reported") && (
                            <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "stop"), "중단을 요청했습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-err/10 hover:text-err" data-orch-worker-stop>
                              중단
                            </button>
                          )}
                          {d.status === "live" && d.execution.state !== "running" && d.execution.state !== "queued" && d.execution.state !== "waiting_permission" && (
                            <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "abandon"), "이 Dispatch를 포기했습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-warn/10 hover:text-warn" data-orch-worker-abandon>
                              포기
                            </button>
                          )}
                          {(d.status === "settled" || d.status === "abandoned" || d.status === "failed_to_start") && !d.cleaned && d.tabId && (
                            <button onClick={() => void cleanup(run.run.id, d.id)} disabled={cleaning.has(d.id)} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-err/10 hover:text-err disabled:opacity-40" title={d.worktree ? "worktree와 탭을 삭제합니다. 커밋하지 않은 변경도 삭제됩니다." : "이 작업의 탭을 닫습니다."} data-orch-worker-cleanup>
                              {cleaning.has(d.id) ? "처리 중…" : d.worktree ? "worktree 삭제" : "탭 닫기"}
                            </button>
                          )}
                          {(d.status === "settled" || d.status === "abandoned" || d.status === "failed_to_start") && !d.cleaned && d.tabId && d.worktree && (
                            <span className="text-[10.5px] text-warn">worktree를 삭제하면 커밋하지 않은 변경도 삭제됩니다.</span>
                          )}
                          {d.cleaned && <span className="text-[10px] text-muted-2">{CLEANUP_LABEL[cleanupState(d.cleaned)]}</span>}
                          {d.status === "settled" && d.ownership === "supervised" && (
                            <>
                              <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "retain"), "이 작업을 삭제하지 않도록 표시했습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-worker-retain>
                                삭제 방지
                              </button>
                              <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "release"), "이 작업의 관리를 해제했습니다. 탭은 그대로 남습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-worker-release>
                                관리 해제
                              </button>
                            </>
                          )}
                        </div>
                      ))}
                      {ds.some((d) => d.status === "live") && (
                        <div className="flex items-center gap-2 border-t border-line px-2.5 py-1">
                          <input
                            value={followup[t.id] ?? ""}
                            onChange={(e) => setFollowup((m) => ({ ...m, [t.id]: e.target.value }))}
                            placeholder="워커에 추가 지시 (다음 진행 확인 시 전달됩니다)"
                            className="min-w-0 flex-1 rounded border border-line bg-inset px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                            data-orch-followup-input
                          />
                          <button
                            onClick={() => {
                              const live = ds.find((d) => d.status === "live");
                              const body = (followup[t.id] ?? "").trim();
                              if (!live || !body) return;
                              void act(window.workbench.orch.followup(run.run.id, live.id, body), "후속 지시를 보냈습니다.").then(() => setFollowup((m) => ({ ...m, [t.id]: "" })));
                            }}
                            className="rounded border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
                            data-orch-followup-send
                          >
                            보내기
                          </button>
                        </div>
                      )}
                    </div>
                  );
                }); })()}
              </div>
              <div className="px-4 py-2">
                <div className="label mb-1 text-muted">
                  인박스{a && a.questions.length > 0 ? ` · 답변 대기 ${a.questions.length}개` : ""}
                </div>
                {run.messages.length === 0 && <div className="text-[11.5px] text-muted">메시지가 없습니다.</div>}
                {run.messages
                  .slice()
                  .reverse()
                  .map((m) => {
                    const [label, tone] = MSG_LABEL[m.type];
                    const task = run.tasks.find((t) => t.id === m.taskId);
                    return (
                      <div key={m.id} className="mb-1.5 rounded-md border border-line px-2.5 py-1.5" data-orch-message={m.id} data-orch-message-type={m.type}>
                        <div className="flex items-center gap-2 text-[10.5px] text-muted-2">
                          <span className={`label ${tone}`}>{label}</span>
                          <span>{fmtActor(m.from)}</span>
                          {task && <span>· Task {task.seq}</span>}
                          {m.outcome && <span className={m.outcome === "succeeded" ? "text-ok" : "text-err"}>· {m.outcome === "succeeded" ? "성공" : "실패"}</span>}
                          <span className="flex-1" />
                          <span className="mono">{new Date(m.ts).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}</span>
                        </div>
                        <div className="mt-0.5 whitespace-pre-wrap text-[12px]" style={{ userSelect: "text" }}>
                          {m.body || m.subject}
                        </div>
                        {m.filesModified && m.filesModified.length > 0 && <div className="mono mt-0.5 text-[10.5px] text-muted-2">{m.filesModified.join(", ")}</div>}
                        {m.type === "question" && !m.answer && (
                          <div className="mt-1.5 flex flex-col gap-1" data-orch-answer={m.id}>
                            {m.options && m.options.length > 0 && (
                              <div className="flex flex-wrap gap-1">
                                {m.options.map((o) => (
                                  <button key={o} onClick={() => void act(window.workbench.orch.reply(run.run.id, m.id, o), "답을 보냈습니다.")} className="rounded-md border border-accent/40 bg-accent-tint px-2 py-0.5 text-[11.5px] text-accent hover:bg-accent/15" data-orch-answer-option={o}>
                                    {o}
                                  </button>
                                ))}
                              </div>
                            )}
                            <div className="flex items-center gap-2">
                              <input
                                value={answers[m.id] ?? ""}
                                onChange={(e) => setAnswers((s) => ({ ...s, [m.id]: e.target.value }))}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && (answers[m.id] ?? "").trim()) void act(window.workbench.orch.reply(run.run.id, m.id, answers[m.id].trim()), "답을 보냈습니다.");
                                }}
                                placeholder="답 입력 후 Enter"
                                className="min-w-0 flex-1 rounded border border-line bg-inset px-2 py-1 text-[11.5px] outline-none focus:border-accent"
                                data-orch-answer-input
                              />
                              <button onClick={() => (answers[m.id] ?? "").trim() && void act(window.workbench.orch.reply(run.run.id, m.id, answers[m.id].trim()), "답을 보냈습니다.")} className="rounded border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-answer-send>
                                답하기
                              </button>
                            </div>
                          </div>
                        )}
                        {m.type === "question" && m.answer && (
                          <div className="mt-1 text-[11.5px] text-ok" data-orch-answered>
                            답: {m.answer.body} <span className="text-muted-2">({fmtActor(m.answer.by)})</span>
                          </div>
                        )}
                      </div>
                    );
                  })}
              </div>
            </div>
          ) : (
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted">왼쪽에서 Run을 고르세요.</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
