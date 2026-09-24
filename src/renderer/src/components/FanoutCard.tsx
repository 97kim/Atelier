// 팬아웃 카드 — 세션별 진행 상태·변경 통계·답변 요약. 끝나면 "비교" 로 diff 를 나란히 보고 채택, "정리" 로 worktree 와 탭을 지운다.
import { useEffect, useState } from "react";
import type { FanoutVariant } from "@shared/chat-events";
import type { FanoutBlock } from "@shared/session-state";
import { PROVIDER_NAME, fanoutSummary } from "@shared/fanout";
import { formatDuration } from "@shared/verify";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

function VariantStatus({ v }: { v: FanoutVariant }) {
  if (v.status === "running")
    return (
      <span className="label flex items-center gap-1.5 text-accent">
        <span className="spin inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-accent border-t-transparent" />
        <span className="shimmer" style={{ "--shimmer-base": "var(--color-accent)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties}>
          진행 중
        </span>
      </span>
    );
  if (v.status === "waiting") return <span className="label text-warn">응답 필요</span>;
  if (v.status === "failed") return <span className="label text-err">실패</span>;
  if (v.status === "cleaned") return <span className="label text-muted-2">비교 종료</span>;
  return <span className="label text-ok">완료</span>;
}

export function FanoutCard({ block, tabId, onCompare }: { block: FanoutBlock; tabId: string; onCompare: (fanoutId: string) => void }) {
  const running = block.status === "running";
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [running]);
  const [confirmClean, setConfirmClean] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const cleanup = async () => {
    setBusy(true);
    setMsg(null);
    const r = await window.workbench.chat.fanoutCleanup(tabId, block.id);
    setBusy(false);
    setConfirmClean(false);
    if (!r.ok) setMsg(r.error);
  };
  const secs = Math.max(0, Math.floor((now - block.ts) / 1000));
  const canCompare = block.variants.some((v) => v.status === "done" || v.status === "failed");
  return (
    <div className="content-indent rounded-lg border border-line bg-panel" data-fanout-card={block.id} data-fanout-status={block.status}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="sparkles" size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-medium">팬아웃</span>
        <span className="text-[11px] text-muted" data-fanout-summary>
          {fanoutSummary(block.variants)}
        </span>
        {running && secs >= 3 && <span className="mono text-[10.5px] text-muted-2">{secs >= 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs}초`}</span>}
        <span className="flex-1" />
        {block.adoptedTabId && (
          <span className="label text-ok" data-fanout-adopted={block.adoptedTabId}>
            {block.variants.find((v) => v.tabId === block.adoptedTabId)?.label ?? "?"} 채택됨
          </span>
        )}
        <button
          onClick={() => onCompare(block.id)}
          disabled={!canCompare || block.status === "cleaned"}
          className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
          title="세션별 diff를 나란히 보고 원본에 적용할 결과를 고릅니다"
          data-fanout-compare
        >
          비교
        </button>
        {block.status !== "cleaned" && !confirmClean && (
          <button
            onClick={() => setConfirmClean(true)}
            disabled={busy}
            className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
            title="세션의 worktree를 모두 삭제하고 탭을 닫습니다"
            data-fanout-cleanup
          >
            worktree 삭제
          </button>
        )}
      </div>
      <div className="px-3 py-1.5 text-[12px] text-muted" style={{ userSelect: "text" }}>
        {block.prompt}
      </div>
      <div>
        {block.variants.map((v) => (
          <div key={v.tabId} className="flex items-start gap-2 border-t border-line px-3 py-2" data-fanout-variant={v.label} data-fanout-variant-status={v.status}>
            <span className="mono mt-0.5 w-4 shrink-0 text-[11px] text-muted">{v.label}</span>
            <ProviderLogo provider={v.provider} size={16} className="mt-0.5 shrink-0" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="text-[12px]">
                  {PROVIDER_NAME[v.provider]}
                  {v.model ? <span className="mono ml-1 text-[10.5px] text-muted-2">{v.model}</span> : null}
                </span>
                <VariantStatus v={v} />
                {v.files !== undefined && (
                  <span className="mono text-[10.5px] text-muted-2" data-fanout-stats>
                    {v.files}개 파일 <span className="text-ok">+{v.added ?? 0}</span> <span className="text-err">−{v.deleted ?? 0}</span>
                  </span>
                )}
                {typeof v.durationMs === "number" && <span className="mono text-[10.5px] text-muted-2">{formatDuration(v.durationMs)}</span>}
                <span className="flex-1" />
                {v.status !== "cleaned" && (
                  <button
                    onClick={() => void window.workbench.workspaces.activateTab(v.tabId)}
                    className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
                    title="이 세션의 탭 열기"
                    data-fanout-open
                  >
                    탭
                  </button>
                )}
              </div>
              {v.summary && (
                <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted" style={{ userSelect: "text" }}>
                  {v.summary}
                </div>
              )}
              {v.error && <div className="mt-0.5 text-[11.5px] text-err">{v.error}</div>}
            </div>
          </div>
        ))}
      </div>
      {confirmClean && (
        <div className="flex items-center gap-2 border-t border-err/30 bg-err-bg px-3 py-2 text-[11.5px] text-err" data-fanout-cleanup-confirm>
          <span className="flex-1">모든 세션의 worktree와 탭을 삭제합니다. 커밋하지 않은 변경도 삭제됩니다. 필요한 결과를 먼저 원본에 적용하거나 따로 보관하세요.</span>
          <button onClick={() => void cleanup()} disabled={busy} className="rounded border border-err/40 px-2 py-0.5 hover:bg-err/10" data-fanout-cleanup-yes>
            {busy ? "삭제 중…" : "worktree 삭제"}
          </button>
          <button onClick={() => setConfirmClean(false)} className="rounded px-1.5 py-0.5 hover:bg-err/10">
            취소
          </button>
        </div>
      )}
      {msg && <div className="border-t border-line px-3 py-1.5 text-[11.5px] text-err">{msg}</div>}
    </div>
  );
}
