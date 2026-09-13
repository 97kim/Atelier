// 오케스트레이션 패널(오버레이): Run 목록 · Task/워커 · 인박스. 사람이 여기서 워커 질문에 답하고, 후속 지시를 보내고, 워커를 정리한다.
// 화면을 연 것만으로 코디네이터 Delivery 를 ack 하지 않는다(코디네이터 탭의 check 가 소비한다).
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { OrchDispatch, OrchMessage, OrchRunState } from "@shared/orchestration";
import { attention, runSummary, taskBlockers, taskWaves } from "@shared/orchestration";
import { PROVIDER_NAME } from "@shared/fanout";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

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
  reported: "보고됨 · 정산 대기",
  settled: "정산됨",
  abandoned: "포기됨",
  failed_to_start: "시작 실패",
};

function fmtActor(a: OrchMessage["from"]): string {
  return a.kind === "user" ? "사람" : a.kind === "app" ? "앱" : a.kind === "tab" ? "코디네이터 탭" : "워커";
}

export function OrchestrationPanel({ initialRunId, onClose }: { initialRunId: string | null; onClose: () => void }) {
  const [runs, setRuns] = useState<OrchRunState[]>([]);
  const [selected, setSelected] = useState<string | null>(initialRunId);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [followup, setFollowup] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => void window.workbench.orch.list().then((r) => setRuns(r));
  useEffect(() => {
    load();
    return window.workbench.orch.onChanged(() => load());
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
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
    setMsg(r.ok ? { ok: true, text: okText } : { ok: false, text: r.error });
    setTimeout(() => setMsg(null), 4000);
  };
  const a = run ? attention(run) : null;
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay/60 p-5" onClick={onClose} data-orch-panel>
      <div className="flex h-full w-full max-w-[1400px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Icon name="list" size={15} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">오케스트레이션</div>
            <div className="mt-0.5 text-[10.5px] text-muted">Run 의 Task·워커·인박스. 워커의 질문에 답하고, 후속 지시를 보내고, 끝난 워커를 정리합니다.</div>
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
            {runs.length === 0 && <div className="px-3 py-3 text-[11.5px] text-muted">Run 이 없습니다. CLI 로 만듭니다: atelier orch run-create --objective "…"</div>}
            {runs.map((r) => {
              const at = attention(r);
              return (
                <button key={r.run.id} onClick={() => setSelected(r.run.id)} className={`flex flex-col gap-0.5 border-b border-line px-3 py-2 text-left ${run?.run.id === r.run.id ? "bg-accent-tint" : "hover:bg-panel-2"}`} data-orch-run={r.run.id}>
                  <span className="truncate text-[12px]">{r.run.objective}</span>
                  <span className="mono text-[10px] text-muted-2">
                    {r.run.id} · {r.run.coordinator.kind === "tab" ? "탭 코디네이터" : "사람"} · {r.run.status === "closed" ? "닫힘" : runSummary(r)}
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
                  <button onClick={() => void act(window.workbench.orch.takeover(run.run.id), "코디네이터를 인수했습니다.")} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title="탭 코디네이터의 키를 무효화하고 사람이 인박스를 맡습니다" data-orch-takeover>
                    코디네이터 인수
                  </button>
                )}
                {run.run.status === "active" && (
                  <button onClick={() => void act(window.workbench.orch.close(run.run.id), "Run 을 닫았습니다.")} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-close>
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
                        {maxWave > 1 && <span className="mono rounded bg-inset px-1 text-[10px] text-muted-2" title="웨이브(의존 깊이)" data-orch-wave={wave}>W{wave}</span>}
                        <span className="min-w-0 flex-1 truncate text-[12px]" title={t.spec}>
                          {t.spec.split("\n")[0]}
                        </span>
                        {t.deps.length > 0 && (
                          <span className="mono text-[10px] text-muted-2" title={`의존: ${t.deps.join(", ")}`}>
                            ← {t.deps.map((id) => run.tasks.find((x) => x.id === id)?.seq ?? "?").join(",")}
                          </span>
                        )}
                        {t.status === "pending" && b.unmetDeps.length > 0 && <span className="label text-muted-2">의존 대기</span>}
                        {t.status === "pending" && b.pendingGates.length > 0 && <span className="label text-warn">게이트 대기</span>}
                        <span className={`label ${t.status === "succeeded" ? "text-ok" : t.status === "failed" || t.status === "abandoned" ? "text-err" : t.status === "running" ? "text-accent" : "text-muted-2"}`}>{t.status}</span>
                      </div>
                      {gates.map((g) => (
                        <div key={g.id} className="flex flex-wrap items-center gap-2 border-t border-line bg-warn-bg/40 px-2.5 py-1 text-[11.5px]" data-orch-gate={g.id} data-orch-gate-resolved={g.resolution ? "true" : "false"}>
                          <span className="label text-warn">게이트</span>
                          <span className="min-w-0 flex-1">{g.question}</span>
                          {g.resolution ? (
                            <span className="text-ok">결정: {g.resolution.choice}</span>
                          ) : (
                            g.options.map((o) => (
                              <button key={o} onClick={() => void act(window.workbench.orch.gate(run.run.id, g.id, o), `게이트를 "${o}" 로 결정했습니다.`)} className="rounded-md border border-warn/40 px-2 py-0.5 text-[11px] text-warn hover:bg-warn/10" data-orch-gate-option={o}>
                                {o}
                              </button>
                            ))
                          )}
                        </div>
                      ))}
                      {ds.map((d) => (
                        <div key={d.id} className="flex items-center gap-2 border-t border-line px-2.5 py-1 text-[11.5px]" data-orch-dispatch={d.id} data-orch-dispatch-status={d.status}>
                          <ProviderLogo provider={d.provider} size={13} />
                          <span className="text-muted">
                            {PROVIDER_NAME[d.provider]} · 시도 {d.attempt} · {DISPATCH_LABEL[d.status]}
                            {d.status === "live" ? ` (${d.execution.state})` : ""} · {d.ownership}
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
                            <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "abandon"), "abandon 했습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-warn/10 hover:text-warn" data-orch-worker-abandon>
                              포기
                            </button>
                          )}
                          {(d.status === "settled" || d.status === "abandoned" || d.status === "failed_to_start") && !d.cleaned && d.tabId && (
                            <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "cleanup"), "탭을 닫고 worktree 를 지웠습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-err/10 hover:text-err" title="탭을 닫고 worktree 를 지웁니다(커밋 안 된 변경 포함)" data-orch-worker-cleanup>
                              정리
                            </button>
                          )}
                          {d.cleaned && <span className="text-[10px] text-muted-2">정리됨</span>}
                          {d.status === "settled" && d.ownership === "supervised" && (
                            <>
                              <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "retain"), "보존했습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-worker-retain>
                                보존
                              </button>
                              <button onClick={() => void act(window.workbench.orch.worker(run.run.id, d.id, "release"), "해제했습니다.")} className="rounded border border-line px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" data-orch-worker-release>
                                해제
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
                            placeholder="워커에게 후속 지시 (워커는 다음 체크포인트에서 읽습니다)"
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
                  인박스{a && a.questions.length > 0 ? ` · 답 없는 질문 ${a.questions.length}` : ""}
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
                          {m.outcome && <span className={m.outcome === "succeeded" ? "text-ok" : "text-err"}>· {m.outcome}</span>}
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
            <div className="flex flex-1 items-center justify-center text-[12px] text-muted">왼쪽에서 Run 을 고르세요.</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
