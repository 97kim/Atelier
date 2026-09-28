// 팬아웃 비교 오버레이 — 왼쪽은 모든 세션이 건드린 파일의 합집합, 오른쪽은 세션별 열(그 파일의 diff). 열 머리에서 "채택".
import { usePaneFocusRef } from "../pane-focus";
import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { FanoutCompareDto } from "@shared/ipc";
import { PROVIDER_NAME, changeStats, unionPaths } from "@shared/fanout";
import { UnifiedDiff } from "./DiffView";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

export function FanoutCompare({ tabId, fanoutId, adoptedTabId, onClose }: { tabId: string; fanoutId: string; adoptedTabId?: string; onClose: () => void }) {
  const [data, setData] = useState<FanoutCompareDto | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [current, setCurrent] = useState<string | null>(null);
  const [adopting, setAdopting] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = () => {
    setError(null);
    window.workbench.chat
      .fanoutCompare(tabId, fanoutId)
      .then((d) => {
        setData(d);
        setCurrent((c) => c ?? unionPaths(d.variants)[0]?.path ?? null);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };
  useEffect(load, [tabId, fanoutId]);
  const paneFocus = usePaneFocusRef();
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!paneFocus.current) return; // 분할 화면의 다른 칸이 연 모달이면 그쪽 몫
      if (e.key !== "Escape") return;
      e.stopPropagation();
      e.preventDefault();
      if (confirm) setConfirm(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, confirm]);
  const files = useMemo(() => (data ? unionPaths(data.variants) : []), [data]);
  const adopt = async (variantTabId: string) => {
    setAdopting(variantTabId);
    setMsg(null);
    const r = await window.workbench.chat.fanoutAdopt(tabId, fanoutId, variantTabId);
    setAdopting(null);
    setConfirm(null);
    setMsg(r.ok ? { ok: true, text: `${r.files.length}개 파일을 원본 저장소에 적용했습니다. 변경 리뷰에서 확인하고 커밋하세요.` } : { ok: false, text: r.error });
  };
  return createPortal(
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay/60 p-5" onClick={onClose} data-fanout-compare-view>
      <div className="flex h-full w-full max-w-[1500px] flex-col overflow-hidden rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Icon name="sparkles" size={15} className="shrink-0 text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">팬아웃 비교</div>
            <div className="mt-0.5 text-[10.5px] text-muted">
              {data ? `${data.variants.length}개 세션 · ${files.length}개 파일` : "불러오는 중…"} · 파일을 고르면 세션별 diff를 나란히 볼 수 있습니다
            </div>
          </div>
          {msg && (
            <span className={`text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`} data-fanout-adopt-msg={msg.ok ? "ok" : "error"}>
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
        {error && <div className="px-5 py-3 text-err">{error}</div>}
        <div className="flex min-h-0 flex-1">
          <div className="flex w-[280px] shrink-0 flex-col overflow-y-auto border-r border-line" data-fanout-files>
            {files.length === 0 && data && <div className="px-3 py-3 text-[11.5px] text-muted">변경된 파일이 없습니다.</div>}
            {files.map((f) => (
              <button
                key={f.path}
                onClick={() => setCurrent(f.path)}
                className={`flex items-center gap-2 border-b border-line px-3 py-1.5 text-left ${current === f.path ? "bg-accent-tint" : "hover:bg-panel-2"}`}
                data-fanout-file={f.path}
              >
                <span className="mono min-w-0 flex-1 truncate text-[11.5px]">{f.path}</span>
                <span className="mono shrink-0 text-[10px] text-muted-2">{f.labels.join(" ")}</span>
              </button>
            ))}
          </div>
          <div className="flex min-w-0 flex-1 overflow-x-auto">
            {data?.variants.map((v) => {
              const stats = changeStats(v.changes);
              const diff = current ? v.diffs[current] : undefined;
              const adopted = adoptedTabId === v.tabId;
              return (
                <div key={v.tabId} className="flex min-w-[360px] flex-1 flex-col border-r border-line last:border-r-0" data-fanout-column={v.label}>
                  <div className="flex items-center gap-2 border-b border-line bg-inset px-3 py-2">
                    <span className="mono text-[11px] text-muted">{v.label}</span>
                    <ProviderLogo provider={v.provider} size={14} />
                    <span className="text-[12px] font-medium">{PROVIDER_NAME[v.provider]}</span>
                    <span className="mono text-[10.5px] text-muted-2">
                      {stats.files}개 파일 <span className="text-ok">+{stats.added}</span> <span className="text-err">−{stats.deleted}</span>
                    </span>
                    <span className="flex-1" />
                    {adopted ? (
                      <span className="label text-ok">채택됨</span>
                    ) : confirm === v.tabId ? (
                      <span className="flex items-center gap-1 text-[11px]">
                        <span className="text-muted">원본에 적용?</span>
                        <button onClick={() => void adopt(v.tabId)} disabled={adopting !== null} className="rounded bg-accent px-2 py-0.5 text-on-accent disabled:opacity-40" data-fanout-adopt-yes>
                          {adopting === v.tabId ? "적용 중…" : "적용"}
                        </button>
                        <button onClick={() => setConfirm(null)} className="rounded px-1.5 py-0.5 hover:bg-panel-2">
                          취소
                        </button>
                      </span>
                    ) : (
                      <button
                        onClick={() => setConfirm(v.tabId)}
                        disabled={!v.exists || v.changes.length === 0 || adopting !== null}
                        className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
                        title="이 세션의 패치를 원본 저장소에 적용합니다. 커밋은 직접 해야 합니다"
                        data-fanout-adopt={v.tabId}
                      >
                        채택
                      </button>
                    )}
                    <button onClick={() => void window.workbench.workspaces.activateTab(v.tabId)} className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title="이 세션의 탭 열기">
                      탭
                    </button>
                  </div>
                  <div className="min-h-0 flex-1 overflow-y-auto p-3">
                    {v.summary && !current && <div className="text-[12px] text-muted" style={{ userSelect: "text" }}>{v.summary}</div>}
                    {!v.exists && <div className="text-[11.5px] text-muted">worktree가 없어 diff를 볼 수 없습니다.</div>}
                    {v.exists && current && (diff ? <UnifiedDiff diff={diff} /> : <div className="text-[11.5px] text-muted-2" data-fanout-nochange>이 세션은 이 파일을 변경하지 않았습니다.</div>)}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
