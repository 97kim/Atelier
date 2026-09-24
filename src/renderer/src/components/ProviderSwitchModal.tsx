import { useEffect, useState } from "react";
import type { Handoff } from "@shared/handoff";
import { PROVIDERS, type CliStatusDto, type Provider } from "@shared/ipc";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

import { modelOptions, useModels } from "../models";

const LABEL: Record<Provider, string> = { claude: "Claude Code", codex: "OpenAI Codex" };

export function ProviderSwitchModal({
  current,
  running,
  onClose,
  onSwitch,
  loadHandoff,
}: {
  current: Provider;
  running: boolean;
  onClose: () => void;
  onSwitch: (opts: { provider: Provider; model?: string; preserveContext: boolean; askSummary?: boolean }) => Promise<void>;
  loadHandoff: () => Promise<Handoff>;
}) {
  // 미리 고르지 않는다 — 사용자가 목록에서 직접 고른 뒤 확인한다(제공자가 늘어도 같은 흐름).
  const [selected, setSelected] = useState<Provider | null>(null);
  const [model, setModel] = useState("");
  const [preserve, setPreserve] = useState(true);
  // 떠나는 쪽이 직접 쓴 인계서가 우리가 기록을 잘라 만든 요약보다 낫다 — 기본값으로 둔다.
  const [askSummary, setAskSummary] = useState(true);
  const [status, setStatus] = useState<Record<Provider, CliStatusDto | null>>({ claude: null, codex: null });
  const [handoff, setHandoff] = useState<Handoff | null>(null);
  const [busy, setBusy] = useState(false);
  const { models: targetModels } = useModels(selected ?? current);

  useEffect(() => {
    for (const p of PROVIDERS) {
      window.workbench.cli.status(p).then((s) => setStatus((prev) => ({ ...prev, [p]: s })));
    }
    loadHandoff().then(setHandoff).catch(console.error);
  }, [loadHandoff]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
      // 네이티브 <select> 에서 항목을 고르는 Enter 는 확인이 아니다
      const inField = e.target instanceof HTMLSelectElement || e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      if (e.key === "Enter" && !busy && !inField) void confirm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  const canConfirm = selected !== null && selected !== current && !!status[selected]?.installed;
  const confirm = async () => {
    if (!canConfirm || !selected) return;
    setBusy(true);
    try {
      await onSwitch({ provider: selected, model: model || undefined, preserveContext: preserve, askSummary: preserve && askSummary });
      onClose();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="absolute inset-0 z-20 flex items-center justify-center bg-overlay/60" onClick={onClose}>
      <div
        className="w-[640px] rounded-xl border border-line bg-panel shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between border-b border-line px-6 py-5">
          <div>
            <h2 className="text-[17px] font-semibold">코딩 에이전트 전환</h2>
            <p className="mt-1 text-muted">작업을 이어갈 CLI를 바꿉니다. 이전 대화의 요약을 함께 전달할 수 있습니다.</p>
          </div>
          <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg">
            <Icon name="x" size={14} />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-6 py-5">
          <div>
            <div className="label mb-2">전환할 에이전트</div>
            <div className="flex flex-col gap-2" role="radiogroup">
              {PROVIDERS.map((p) => {
                const s = status[p];
                const isCurrent = p === current;
                const disabled = isCurrent || !s?.installed;
                const active = selected === p;
                return (
                  <button
                    key={p}
                    role="radio"
                    aria-checked={active}
                    disabled={disabled}
                    onClick={() => {
                      setSelected(p);
                      setModel(""); // 제공자마다 모델 목록이 다르다
                    }}
                    className={`flex items-center gap-3 rounded-lg border px-4 py-3 text-left ${
                      active ? "border-accent bg-accent-tint" : "border-line bg-panel-2/40 hover:bg-panel-2"
                    } ${disabled ? "cursor-default opacity-60 hover:bg-panel-2/40" : ""}`}
                    data-agent-option={p}
                  >
                    <ProviderLogo provider={p} size={36} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2">
                        <span className="font-medium">{LABEL[p]}</span>
                        {isCurrent && <span className="label rounded bg-line px-1.5 py-0.5">현재</span>}
                        {!isCurrent && s?.installed && <span className="label rounded bg-ok-bg px-1.5 py-0.5 text-ok">준비됨</span>}
                        {s && !s.installed && <span className="label rounded bg-err-bg px-1.5 py-0.5 text-err" title={s.error}>미설치</span>}
                      </span>
                      <span className="mono mt-0.5 block truncate text-muted" title={s?.path ?? ""}>
                        {s?.version ?? (s ? "" : "확인 중…")}
                        {s?.path ? ` · ${s.path}` : ""}
                      </span>
                    </span>
                    {!isCurrent && (
                      <span className={`h-4 w-4 shrink-0 rounded-full border-2 ${active ? "border-accent bg-accent" : "border-muted-2"}`} />
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <div>
            <div className="label mb-2">전환 옵션</div>
            <div className="rounded-lg border border-line bg-panel-2/40">
              <div className="flex items-center justify-between border-b border-line px-4 py-3">
                <div>
                  <div className="font-medium">모델</div>
                  <div className="text-muted">전환 후 보낼 메시지부터 사용합니다.</div>
                </div>
                <select
                  value={model}
                  disabled={!selected}
                  onChange={(e) => setModel(e.target.value)}
                  className="mono rounded-md border border-line bg-panel px-2.5 py-1.5 disabled:opacity-50"
                  title={selected ? "" : "먼저 전환할 에이전트를 고르세요"}
                >
                  {modelOptions(targetModels, model, status[selected ?? current]?.defaultModel).map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="flex items-center justify-between px-4 py-3">
                <div>
                  <div className="font-medium">대화 요약을 첫 메시지로 전달</div>
                  <div className="text-muted">
                    전환할 AI는 이전 대화를 직접 볼 수 없어, 요약을 다음 메시지와 함께 전달합니다.
                  </div>
                </div>
                <Toggle value={preserve} onChange={setPreserve} />
              </div>
              {preserve && (
                <div className="flex items-center justify-between border-t border-line px-4 py-3">
                  <div>
                    <div className="font-medium">현재 AI가 작업 내용을 요약</div>
                    <div className="text-muted">
                      현재 AI에 요약을 요청합니다. 응답을 한 번 더 생성하므로 시간과 사용량이 추가됩니다.
                    </div>
                  </div>
                  <Toggle value={askSummary} onChange={setAskSummary} />
                </div>
              )}
            </div>
          </div>

          {preserve && handoff && (
            <div className="rounded-lg border border-accent/30 bg-accent-tint px-4 py-3">
              <div className="mb-2 flex items-center gap-2 font-medium">
                <Icon name="file" size={13} className="text-accent" />
                {askSummary ? "요약 요청이 실패하면 사용할 대화 기록 요약" : "요약 준비됨"}
              </div>
              <div className="flex gap-8">
                {[
                  [handoff.stats.messages, "메시지"],
                  [handoff.stats.files, "파일"],
                  [handoff.stats.pendingTasks, "남은 할 일"],
                  [`${(handoff.stats.tokensEstimate / 1000).toFixed(1)}K`, "토큰(추정)"],
                ].map(([v, l]) => (
                  <div key={String(l)}>
                    <div className="mono text-[14px]">{v}</div>
                    <div className="text-[11px] text-muted">{l}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {running && (
            <div className="flex items-center gap-2 rounded-md bg-warn-bg px-3 py-2 text-warn">
              <Icon name="info" size={13} />
              진행 중인 작업을 중단하고 전환합니다. 중단 전에 변경한 파일은 그대로 남습니다.
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t border-line px-6 py-4">
          <span className="mono text-[10px] text-muted">esc 취소 · ⏎ 확인</span>
          <div className="flex gap-2">
            <button onClick={onClose} className="rounded-md border border-line px-4 py-1.5 hover:bg-panel-2">
              취소
            </button>
            <button
              onClick={() => void confirm()}
              disabled={busy || !canConfirm}
              className="flex items-center gap-2 rounded-md bg-primary px-4 py-1.5 font-medium text-on-primary disabled:opacity-40"
              data-switch-confirm
            >
              <Icon name="switch" size={13} />
              {selected && selected !== current ? `${LABEL[selected]} 로 전환` : "전환할 에이전트를 고르세요"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className={`relative h-5 w-9 shrink-0 rounded-full transition-colors ${value ? "bg-accent" : "bg-line"}`}
    >
      <span
        className={`absolute left-0 top-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform ${
          value ? "translate-x-[18px]" : "translate-x-0.5"
        }`}
      />
    </button>
  );
}
