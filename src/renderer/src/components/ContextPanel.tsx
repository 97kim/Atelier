import { useEffect, useState } from "react";
import type { PermissionPolicy } from "@shared/chat-events";
import type { SessionSnapshotDto } from "@shared/ipc";
import { useGitChanges } from "../hooks/useGitChanges";
import { ChangeReview } from "./ChangeReview";
import { CheckMark, KindBadge } from "./CheckMark";
import { contextUsage, type SessionState } from "@shared/session-state";
import { useOpenFile } from "./FileViewer";
import { Icon } from "./Icon";

const POLICIES: { id: PermissionPolicy; label: string; codexLabel: string; help: string }[] =
  [
    {
      id: "ask",
      label: "변경 전 물어보기",
      codexLabel: "읽기 전용 (Codex 는 승인 대화 없음)",
      help: "쓰기·실행 시 승인을 요청합니다. 승인 대기 중엔 알림이 옵니다.",
    },
    {
      id: "auto_edit",
      label: "편집 자동 승인",
      codexLabel: "작업 디렉토리 쓰기 허용",
      help: "파일 편집은 묻지 않고, 명령 실행 등은 승인을 요청합니다.",
    },
    {
      id: "full",
      label: "전부 자동 (주의)",
      codexLabel: "전체 접근 (주의)",
      help: "승인 없이 실행합니다. 모델이 선택지를 물을 때(AskUserQuestion)만 답을 기다립니다.",
    },
  ];

export function ContextPanel({
  state,
  config,
  onPolicy,
  onClear,
}: {
  state: SessionState;
  config: SessionSnapshotDto | null;
  onPolicy: (p: PermissionPolicy) => void;
  onClear: () => void;
}) {
  const cwd = config?.cwd ?? null;
  const idle =
    state.status === "idle" ||
    state.status === "error" ||
    state.status === "queued";
  // 변경 파일 + 커밋 폼 상태. cwd 가 바뀌거나 턴이 끝날 때 새로 읽는다. 변경 리뷰 오버레이와 공유.
  const g = useGitChanges(cwd, `${idle}:${state.totals.turns}`);
  const { git, changes, selected, selectedPaths, toggle, message, setMessage, busy, draft, commit } = g;
  const gitResult = g.result;
  const [showAll, setShowAll] = useState(false);
  const [reviewOpen, setReviewOpen] = useState(false);
  const [exportResult, setExportResult] = useState<{ ok: boolean; text: string } | null>(null);
  const openFile = useOpenFile();

  const last = state.lastTurn;
  const ctx = contextUsage(state);
  const used = ctx?.used ?? 0;
  const contextWindow = ctx?.window ?? undefined;
  const pct = ctx?.pct ?? null;
  const isCodex = config?.provider === "codex";

  return (
    // 구분선 대신 배경 위에 떠 있는 둥근 카드. 섹션도 선이 아니라 여백으로 나눈다.
    <div className="flex h-full flex-col">
      <div className="flex-1 overflow-y-auto">
        <Section title="저장소" badge={git ? "ACTIVE" : undefined}>
          {cwd ? (
            <>
              <div className="flex items-center gap-2 text-[14px] font-semibold">
                <Icon name="folder" size={14} className="text-muted" />
                {git?.name ?? cwd.split("/").pop()}
              </div>
              <div className="mono mt-1 truncate text-muted" title={cwd}>
                {shorten(cwd)}
              </div>
              {git?.branch && (
                <div className="mt-2 flex gap-1.5">
                  <span className="mono inline-flex items-center gap-1 rounded bg-panel-2 px-2 py-0.5">
                    <Icon name="branch" size={11} />
                    {git.branch}
                  </span>
                </div>
              )}
              {!git && (
                <p className="mt-2 text-muted">git 저장소가 아닙니다.</p>
              )}
            </>
          ) : (
            <p className="text-muted">작업 디렉토리를 선택하세요.</p>
          )}
        </Section>

        <Section
          title="변경 파일"
          badge={changes.length > 0 ? String(changes.length) : undefined}
        >
          {changes.length === 0 ? (
            <p className="text-muted">변경 사항 없음</p>
          ) : (
            <>
              <div className="mb-1.5 flex items-center justify-between text-[10.5px] text-muted">
                <span>{selectedPaths.length}개 선택</span>
                <span className="flex items-center gap-1">
                  <button
                    onClick={() => g.selectAll(selectedPaths.length !== changes.length)}
                    className="rounded px-1 hover:bg-panel-2 hover:text-fg"
                  >
                    {selectedPaths.length === changes.length ? "모두 해제" : "모두 선택"}
                  </button>
                  <span className="text-muted-2">·</span>
                  <button
                    onClick={() => setReviewOpen(true)}
                    className="flex items-center gap-1 rounded px-1 text-accent hover:bg-panel-2"
                    title="파일별 diff 를 보며 되돌리기·커밋"
                    data-review-open
                  >
                    <Icon name="branch" size={10} />
                    리뷰
                  </button>
                </span>
              </div>
              <ul className="flex flex-col gap-px" data-git-changes>
                {(showAll ? changes : changes.slice(0, 12)).map((c) => {
                  const on = selected.has(c.path);
                  const open = () => openFile(git ? `${git.root}/${c.path}` : c.path);
                  return (
                    <li key={c.path}>
                      {/* 행 전체가 토글. 파일 열기는 오른쪽 hover 아이콘 또는 더블클릭. */}
                      <div
                        role="checkbox"
                        aria-checked={on}
                        aria-label={`${c.path} 커밋에 포함`}
                        tabIndex={0}
                        onClick={() => toggle(c.path)}
                        onDoubleClick={open}
                        onKeyDown={(e) => {
                          if (e.key === " " || e.key === "Enter") {
                            e.preventDefault();
                            toggle(c.path);
                          }
                        }}
                        className={`group -mx-1.5 flex h-[26px] cursor-default items-center gap-2 rounded-md px-1.5 hover:bg-panel-2 ${
                          on ? "" : "opacity-55"
                        }`}
                        data-change-row={c.path}
                      >
                        <CheckMark checked={on} />
                        <KindBadge kind={c.kind} />
                        <span className="mono min-w-0 flex-1 truncate text-fg" title={c.path}>
                          {c.path}
                        </span>
                        <span className="mono shrink-0 text-[10px] tabular-nums group-hover:hidden">
                          {c.added > 0 && <span className="text-ok">+{c.added}</span>}
                          {c.added > 0 && c.deleted > 0 && " "}
                          {c.deleted > 0 && <span className="text-err">−{c.deleted}</span>}
                        </span>
                        <button
                          onClick={(e) => {
                            e.stopPropagation();
                            open();
                          }}
                          className="hidden shrink-0 rounded p-0.5 text-muted hover:bg-panel hover:text-fg group-hover:block"
                          title="파일 열기"
                          data-change-open
                        >
                          <Icon name="file" size={12} />
                        </button>
                      </div>
                    </li>
                  );
                })}
                {changes.length > 12 && (
                  <li>
                    <button
                      onClick={() => setShowAll((v) => !v)}
                      className="text-muted hover:text-fg"
                    >
                      {showAll ? "접기" : `외 ${changes.length - 12}개 보기`}
                    </button>
                  </li>
                )}
              </ul>

              <div className="mt-3 flex flex-col gap-1.5" data-git-commit>
                <textarea
                  value={message}
                  onChange={(e) => setMessage(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && e.metaKey) {
                      e.preventDefault();
                      void commit();
                    }
                  }}
                  rows={message.includes("\n") ? 5 : 2}
                  placeholder="커밋 메시지 (⌘⏎ 커밋)"
                  disabled={busy !== null}
                  className="mono w-full resize-none rounded-md border border-line bg-inset px-2 py-1.5 text-[11.5px] leading-5 text-fg outline-none placeholder:text-muted focus:border-accent/50 disabled:opacity-60"
                  style={{ userSelect: "text" }}
                />
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={() => void draft()}
                    disabled={busy !== null || selectedPaths.length === 0}
                    className="flex items-center gap-1 rounded-md border border-line px-2 py-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
                    title="고른 파일의 diff 로 Claude(haiku) 에게 커밋 메시지 초안을 받습니다"
                    data-git-draft
                  >
                    <Icon name="sparkles" size={11} />
                    {busy === "draft" ? "초안 작성 중…" : "초안"}
                  </button>
                  <button
                    onClick={() => void commit()}
                    disabled={
                      busy !== null ||
                      !idle ||
                      selectedPaths.length === 0 ||
                      !message.trim()
                    }
                    className="ml-auto flex items-center gap-1 rounded-md bg-primary px-2.5 py-1 font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
                    title={
                      !idle
                        ? "턴이 실행 중일 때는 커밋하지 않습니다"
                        : "고른 파일만 커밋합니다 (파일의 작업 트리 내용 전체가 들어갑니다)"
                    }
                    data-git-commit-button
                  >
                    <Icon name="check" size={11} />
                    {busy === "commit" ? "커밋 중…" : `커밋 ${selectedPaths.length}`}
                  </button>
                </div>
                {gitResult && (
                  <p
                    className={`mono text-[10.5px] ${gitResult.ok ? "text-ok" : "text-err"}`}
                    data-git-result
                  >
                    {gitResult.text}
                  </p>
                )}
              </div>
            </>
          )}
        </Section>

        <Section
          title="컨텍스트 사용량"
          badge={pct !== null ? `${pct}%` : undefined}
          badgeClass="text-accent"
        >
          {last ? (
            <>
              {pct !== null && (
                <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
                  <div
                    className="h-full rounded-full bg-accent"
                    style={{ width: `${pct}%` }}
                  />
                </div>
              )}
              <div className="mono flex justify-between text-muted">
                <span>{fmt(used)} 사용</span>
                <span>
                  {contextWindow ? `${fmt(contextWindow)} 최대` : "최대 미상"}
                </span>
              </div>
              <div className="mono mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-muted">
                <Dot
                  color="bg-accent"
                  label={`입력 ${fmt(last.usage.input)}`}
                />
                <Dot
                  color="bg-accent-2"
                  label={`캐시 ${fmt(last.usage.cacheRead)}`}
                />
                <Dot color="bg-ok" label={`출력 ${fmt(last.usage.output)}`} />
              </div>
              <p className="mt-2 text-[10px] text-muted">
                마지막 턴 기준. 누적 {state.totals.turns}턴 · $
                {state.totals.costUsd.toFixed(3)}
                {isCodex && " (Codex 비용은 Phase 4 가격표 반영 예정)"}
              </p>
            </>
          ) : (
            <p className="text-muted">아직 턴이 없습니다.</p>
          )}
        </Section>

        <Section title="권한 · 도구">
          <div className="flex flex-col gap-1.5">
            {POLICIES.map((p) => {
              const active = (config?.policy ?? "ask") === p.id;
              return (
                <button
                  key={p.id}
                  onClick={() => onPolicy(p.id)}
                  className={`flex items-center gap-2 rounded-md border px-3 py-2 text-left ${
                    active
                      ? "border-accent/50 bg-accent-tint text-fg"
                      : "border-line text-muted hover:text-fg"
                  }`}
                >
                  <Icon
                    name="shield"
                    size={13}
                    className={active ? "text-accent" : ""}
                  />
                  <span className="flex-1">
                    {isCodex ? p.codexLabel : p.label}
                  </span>
                  {active && (
                    <Icon name="check" size={12} className="text-accent" />
                  )}
                </button>
              );
            })}
          </div>
          <p className="mt-2 text-[10px] text-muted">
            {isCodex
              ? "Codex SDK 는 승인을 물어볼 수 없어 샌드박스 단계로 대응합니다."
              : (POLICIES.find((p) => p.id === (config?.policy ?? "ask"))?.help ?? "")}
          </p>
        </Section>
      </div>

      <div className="bg-inset px-4 py-3">
        <div className="mb-2 flex items-center justify-between">
          <span className="label flex items-center gap-1.5">
            <span
              className={`h-1.5 w-1.5 rounded-full ${idle ? "bg-muted" : "bg-ok"}`}
            />
            {idle ? "대기 중" : "실행 중"}
          </span>
          <Timer since={config?.startedAt ?? null} />
        </div>
        <div className="flex gap-2">
          <button
            onClick={() =>
              config &&
              void window.workbench.chat
                .exportMarkdown(config.tabId)
                .then((p) => p && setExportResult({ ok: true, text: `내보냄: ${p}` }))
                .catch((e: unknown) =>
                  setExportResult({ ok: false, text: e instanceof Error ? e.message : String(e) }),
                )
            }
            disabled={!config || state.blocks.length === 0}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-line py-2 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
            title="이 세션을 마크다운 파일로 저장합니다"
            data-export-button
          >
            <Icon name="file" size={13} />
            내보내기
          </button>
          {/* 휴지통은 과장이었다. 이 버튼은 대화를 지우지 않는다 — 화면에서 치우고 새 세션으로 갈 뿐이고,
              비운 대화는 보관본으로 남는다(탭당 10회분). Claude 쪽 기록도 원래부터 그대로 남아 있었다. */}
          <button
            onClick={onClear}
            className="flex flex-1 items-center justify-center gap-2 rounded-md border border-line py-2 text-muted hover:bg-panel-2 hover:text-fg"
            title="지금 대화를 접고 새 세션으로 시작합니다. 비운 대화는 최근 10회분까지 보관됩니다."
            data-clear-button
          >
            <Icon name="refresh" size={13} />
            새 대화
          </button>
        </div>
        {exportResult && (
          <p className={`mono mt-1.5 text-[10.5px] ${exportResult.ok ? "text-ok" : "text-err"}`}>{exportResult.text}</p>
        )}
        {reviewOpen && cwd && (
          <ChangeReview cwd={cwd} gitState={g} canCommit={idle} onClose={() => setReviewOpen(false)} />
        )}
      </div>
    </div>
  );
}

function Section({
  title,
  badge,
  badgeClass = "",
  children,
}: {
  title: string;
  badge?: string;
  badgeClass?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="px-4 pb-5 pt-2">
      <div className="mb-3 flex items-center justify-between">
        <span className="label">{title}</span>
        {badge && (
          <span
            className={`label rounded bg-panel-2 px-1.5 py-0.5 ${badgeClass}`}
          >
            {badge}
          </span>
        )}
      </div>
      {children}
    </div>
  );
}

function Dot({ color, label }: { color: string; label: string }) {
  return (
    <span className="inline-flex items-center gap-1">
      <span className={`h-1.5 w-1.5 rounded-full ${color}`} />
      {label}
    </span>
  );
}

function Timer({ since }: { since: number | null }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!since) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);
  if (!since) return <span className="mono text-muted">00:00:00</span>;
  const s = Math.max(0, Math.floor((now - since) / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    <span className="mono text-muted">
      {pad(Math.floor(s / 3600))}:{pad(Math.floor((s % 3600) / 60))}:
      {pad(s % 60)}
    </span>
  );
}

export function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

export function shorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}
