// 팬아웃 시작 창 — 지시 하나 + 변형(제공자) 목록 + 정책. 각 변형은 격리 세션(git worktree)에서 돈다.
import { useEffect, useState } from "react";
import type { PermissionPolicy } from "@shared/chat-events";
import type { FanoutStartDto, Provider } from "@shared/ipc";
import { FANOUT_MAX_VARIANTS, FANOUT_MIN_VARIANTS, PROVIDER_NAME, variantLabel } from "@shared/fanout";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { modelOptions, useModels } from "../models";

const POLICY_LABEL: Record<PermissionPolicy, [string, string]> = {
  ask: ["묻기", "도구마다 승인을 기다립니다 — 변형 탭마다 직접 답해야 합니다"],
  auto_edit: ["편집 자동", "파일 편집은 자동, 명령 실행은 묻습니다"],
  full: ["전부 자동", "승인 없이 실행합니다(격리 worktree 안이지만 명령은 PC 에서 돕니다)"],
};

/** 변형 한 줄의 모델 셀렉트 — provider 의 실제 모델 목록(CLI 조회)을 쓴다. */
function VariantModelSelect({ provider, value, onChange }: { provider: Provider; value: string; onChange: (model: string) => void }) {
  const { models, source } = useModels(provider);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.workbench.cli.status(provider).then((s) => alive && setDefaultModel(s.defaultModel ?? null));
    return () => {
      alive = false;
    };
  }, [provider]);
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="mono min-w-0 flex-1 rounded-md border border-line bg-panel px-2 py-1 text-[11px] outline-none focus:border-accent"
      title={source === "loading" ? "모델 목록을 CLI 에서 읽는 중…" : source === "static" ? "CLI 에서 목록을 못 읽어 기본 목록을 보여 줍니다" : "모델 (비우면 CLI 기본 설정)"}
      data-fanout-model
      data-models-source={source}
    >
      {modelOptions(models, value, defaultModel).map((o) => (
        <option key={o.id} value={o.id} title={o.description}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function FanoutModal({
  initialPrompt,
  defaultProvider,
  onStart,
  onClose,
}: {
  initialPrompt: string;
  defaultProvider: Provider;
  onStart: (req: FanoutStartDto) => Promise<string | null>;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(initialPrompt);
  const [variants, setVariants] = useState<{ provider: Provider; model: string }[]>([
    { provider: defaultProvider, model: "" },
    { provider: defaultProvider === "claude" ? "codex" : "claude", model: "" },
  ]);
  const [policy, setPolicy] = useState<PermissionPolicy>("auto_edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  const start = async () => {
    if (!prompt.trim() || busy) return;
    setBusy(true);
    setError(null);
    const err = await onStart({ prompt, variants: variants.map((v) => (v.model.trim() ? { provider: v.provider, model: v.model.trim() } : { provider: v.provider })), policy });
    setBusy(false);
    if (err) setError(err);
    else onClose();
  };
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-overlay/60 p-5" onClick={onClose} data-fanout-modal>
      <div className="w-full max-w-[640px] rounded-xl border border-line bg-panel shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-3 border-b border-line px-5 py-3">
          <Icon name="sparkles" size={15} className="text-accent" />
          <div className="min-w-0 flex-1">
            <div className="text-[14px] font-semibold">팬아웃</div>
            <div className="mt-0.5 text-[11px] text-muted">같은 지시를 격리 세션 여러 개에 동시에 보내고, 끝나면 변경을 나란히 비교해 하나를 채택합니다.</div>
          </div>
          <button onClick={onClose} className="rounded-md border border-line p-1.5 text-muted hover:text-fg" title="닫기 (esc)">
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="flex flex-col gap-4 px-5 py-4">
          <label className="flex flex-col gap-1.5">
            <span className="label text-muted">지시</span>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                  e.preventDefault();
                  void start();
                }
              }}
              rows={5}
              autoFocus
              placeholder="예: 로그인 500 오류를 고치고 테스트를 추가해줘"
              className="w-full resize-y rounded-md border border-line bg-inset px-3 py-2 text-[13px] leading-[1.6] outline-none focus:border-accent"
              data-fanout-prompt
            />
          </label>
          <div className="flex flex-col gap-1.5">
            <span className="label text-muted">변형 ({variants.length}개)</span>
            <div className="flex flex-col gap-1.5" data-fanout-variants>
              {variants.map((v, i) => (
                <div key={i} className="flex items-center gap-2 rounded-md border border-line bg-inset px-2.5 py-1.5" data-fanout-variant={variantLabel(i)}>
                  <span className="mono w-4 text-[11px] text-muted">{variantLabel(i)}</span>
                  {(["claude", "codex"] as Provider[]).map((p) => (
                    <button
                      key={p}
                      // provider 를 바꾸면 모델은 그 provider 의 기본으로(다른 provider 의 모델명이 남지 않게)
                      onClick={() => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, provider: p, model: x.provider === p ? x.model : "" } : x)))}
                      className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[12px] ${v.provider === p ? "border-accent/40 bg-accent-tint text-accent" : "border-line text-muted hover:bg-panel-2"}`}
                      data-fanout-provider={p}
                      data-selected={v.provider === p ? "true" : "false"}
                    >
                      <ProviderLogo provider={p} size={14} />
                      {PROVIDER_NAME[p]}
                    </button>
                  ))}
                  <VariantModelSelect provider={v.provider} value={v.model} onChange={(m) => setVariants((vs) => vs.map((x, j) => (j === i ? { ...x, model: m } : x)))} />
                  <button
                    onClick={() => setVariants((vs) => vs.filter((_, j) => j !== i))}
                    disabled={variants.length <= FANOUT_MIN_VARIANTS}
                    className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
                    title="이 변형 빼기"
                  >
                    <Icon name="x" size={11} />
                  </button>
                </div>
              ))}
            </div>
            {variants.length < FANOUT_MAX_VARIANTS && (
              <button
                onClick={() => setVariants((vs) => [...vs, { provider: vs[vs.length - 1]?.provider === "claude" ? "codex" : "claude", model: "" }])}
                className="flex w-fit items-center gap-1 rounded-md border border-dashed border-line px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
                data-fanout-add
              >
                <Icon name="plus" size={10} />
                변형 추가
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            <span className="label text-muted">권한 정책</span>
            <div className="flex gap-1.5" data-fanout-policy={policy}>
              {(Object.keys(POLICY_LABEL) as PermissionPolicy[]).map((p) => (
                <button
                  key={p}
                  onClick={() => setPolicy(p)}
                  className={`rounded-md border px-2.5 py-1 text-[12px] ${policy === p ? "border-accent/40 bg-accent-tint text-accent" : "border-line text-muted hover:bg-panel-2"}`}
                  title={POLICY_LABEL[p][1]}
                  data-fanout-policy-option={p}
                >
                  {POLICY_LABEL[p][0]}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-muted">{POLICY_LABEL[policy][1]}. 변형은 저장소 밖 worktree 에서 돌아 서로·원본의 파일을 건드리지 않습니다.</div>
          </div>
          {error && (
            <div className="rounded-md border border-err/40 bg-err-bg px-3 py-2 text-[12px] text-err" data-fanout-error>
              {error}
            </div>
          )}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-line px-5 py-3">
          <button onClick={onClose} className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2">
            취소
          </button>
          <button
            onClick={() => void start()}
            disabled={!prompt.trim() || busy}
            className="flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-on-accent hover:bg-accent/90 disabled:opacity-40"
            title="⌘↩"
            data-fanout-start
          >
            <Icon name="play" size={10} />
            {busy ? "worktree 만드는 중…" : `${variants.length}개 세션에 보내기`}
          </button>
        </div>
      </div>
    </div>
  );
}
