import { useEffect, useRef, useState } from "react";
import { clearReveal, onReveal, pendingReveal } from "../reveal";
import type { SessionStatus } from "@shared/chat-events";
import type { Provider } from "@shared/ipc";
import type { Block, ReviewBlock } from "@shared/session-state";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { Logo } from "./Logo";
import { Markdown } from "./Markdown";
import { ToolCard } from "./ToolCard";
import { VerifyCard } from "./VerifyCard";
import { FanoutCard } from "./FanoutCard";
import { OrchestrationCard } from "./OrchestrationCard";

/** 이만큼 위로 올라오면 "사람이 올렸다" 로 본다. 손떨림·서브픽셀 잔동은 넘기고, 한 번의 휠은 넘는다. */
const UP_SLOP = 4;

export function MessageList({
  tabId,
  blocks,
  status,
  provider,
  reasoning = "",
  onRerunVerify,
  onCompareFanout,
  onOpenOrchestration,
  turnStartedAt = null,
  sessionId = null,
}: {
  tabId: string;
  blocks: Block[];
  status: SessionStatus;
  /** 이 탭의 provider 세션 id — 백그라운드 작업이 어느 대화 것인지 잇는 열쇠. */
  sessionId?: string | null;
  /** 지금 턴의 생각(reasoning) 텍스트 꼬리. "생각 중" 아래에 흘려 보여 준다. */
  reasoning?: string;
  provider: Provider;
  /** 검증 카드의 "다시 실행" — 그 카드의 명령들로 다시 돌린다. */
  onRerunVerify?: (commands: string[]) => void;
  /** 팬아웃 카드의 "비교" — 비교 오버레이를 연다. */
  onCompareFanout?: (fanoutId: string) => void;
  /** 오케스트레이션 카드의 "패널". */
  onOpenOrchestration?: (runId: string) => void;
  /** 지금 턴이 실제로 시작된 시각(큐 대기 제외). 없으면 마지막 사용자 메시지 시각. */
  turnStartedAt?: number | null;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // 검색 결과에서 "이 블록으로": 예약된 블록이 이 탭의 것이고 화면에 생겼으면 스크롤 + 잠깐 강조.
  // 블록 목록이 바뀔 때마다(재생 진행) 다시 시도하므로 닫혀 있던 세션도 마운트 뒤 정상 이동한다.
  const [revealTick, setRevealTick] = useState(0);
  useEffect(() => onReveal(() => setRevealTick((n) => n + 1)), []);
  useEffect(() => {
    const blockId = pendingReveal(tabId);
    if (!blockId) return;
    const el = containerRef.current?.querySelector<HTMLElement>(
      `[data-block-id="${CSS.escape(blockId)}"]`,
    );
    if (!el) return;
    clearReveal();
    el.scrollIntoView({ block: "center" });
    el.classList.add("reveal-flash");
    const t = setTimeout(() => el.classList.remove("reveal-flash"), 1600);
    return () => clearTimeout(t);
  }, [tabId, blocks, revealTick]);
  // 자동 스크롤: 사용자가 맨 아래에 있을 때만 따라간다. 위로 올려 읽는 중이면 새 블록(툴카드·응답)이 와도 끌어내리지 않는다 —
  // 자동으로 내려가는데 사람이 올리면 위아래로 튀기 때문. 예외는 사용자가 방금 보낸 메시지(자기 메시지는 보고 싶으니 맨 아래로).
  // 내용 높이가 바뀔 때(스트리밍·이미지·코드 하이라이트)도 같은 규칙으로 따라간다. "맨 아래로" pill 로 언제든 복귀.
  const stickToBottom = useRef(true);
  const contentRef = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  /**
   * 지금까지 본 가장 아래 위치. "사용자가 위로 올렸나" 는 이 기준에서 얼마나 올라왔는지로 본다.
   * 직전 위치와만 비교하면 1px 씩 여러 번 올리는 스크롤을 영영 못 잡는다(매번 기준이 따라 올라가므로).
   */
  const anchorTop = useRef(0);
  const scrollToBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
    anchorTop.current = el.scrollTop;
  };

  // 턴이 돌고 있지만 모델이 아직 말을 시작하지 않은 구간에만 "생각 중 …" 표시:
  // 첫 토큰 전(마지막 블록이 사용자 메시지) 또는 도구 결과를 받은 직후. 글자가 흐르는 중, 도구가 실행 중,
  // 답은 끝났고 turn_result 만 기다리는 꼬리 구간에는 띄우지 않는다.
  const last = blocks[blocks.length - 1];
  const thinking =
    status === "running" &&
    (!last ||
      last.kind === "user" ||
      (last.kind === "tool" && last.result !== undefined));
  // 턴 시작 시각 = 마지막 사용자 메시지. "생각 중" 옆의 경과 시간에 쓴다.
  let lastUserTs: number | null = null;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "user") {
      lastUserTs = b.ts;
      break;
    }
  }

  // 사용자가 위로 스크롤해 읽는 중이면 자동 스크롤을 멈춘다.
  //
  // "바닥에서 멀다" 로 판단하면 안 된다. 글이 흐르는 중에는 우리가 맨 아래로 맞춘 직후에 높이가 또 자라서,
  // 그 사이에 벌어진 간격이 "사용자가 올렸다" 로 읽힌다 — 사람은 손도 안 댔는데 따라가기가 꺼졌다.
  // 위로 갔는지(scrollTop 이 줄었는지)를 직접 본다. 내용이 자라도 scrollTop 은 그대로다.
  const onScroll = () => {
    const el = containerRef.current;
    if (!el) return;
    const near = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const movedUp = el.scrollTop < anchorTop.current - UP_SLOP;
    setAtBottom(near);
    if (near) {
      // 바닥에 닿으면 다시 따라간다. 내용이 줄어 브라우저가 스크롤을 끌어내린 경우도 여기로 들어온다.
      stickToBottom.current = true;
      anchorTop.current = el.scrollTop;
    } else if (movedUp) {
      stickToBottom.current = false;
      anchorTop.current = el.scrollTop;
    } else {
      // 내용이 자란 것뿐이다 — scrollTop 은 그대로다.
      anchorTop.current = Math.max(anchorTop.current, el.scrollTop);
    }
  };
  // 블록 수가 늘었을 때: 마지막이 사용자 메시지면(방금 보냄) 맨 아래로 붙이고, 그 밖의 새 블록은 붙어 있을 때만 따라간다.
  const blockCount = blocks.length;
  const prevCount = useRef(blockCount);
  useEffect(() => {
    if (blockCount > prevCount.current && blocks[blocks.length - 1]?.kind === "user") {
      stickToBottom.current = true;
      setAtBottom(true);
    }
    prevCount.current = blockCount;
    if (stickToBottom.current) scrollToBottom();
  }, [blocks, thinking, blockCount]);
  // 내용 높이가 바뀌면(스트리밍·이미지·하이라이트) 따라 내려간다.
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;
    const ro = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottom();
    });
    ro.observe(content);
    return () => ro.disconnect();
  }, []);

  // 연속된 어시스턴트 블록(text/tool/turn)을 한 그룹으로 묶어 아바타를 한 번만 그린다.
  const groups: { kind: GroupKind; blocks: Block[] }[] = [];
  for (const b of blocks) {
    const kind: GroupKind =
      b.kind === "user" ? "user" : b.kind === "compacted" ? "compacted" : b.kind === "error" ? "error" : b.kind === "review" ? "review" : b.kind === "verify" ? "verify" : b.kind === "fanout" ? "fanout" : b.kind === "orchestration" ? "orchestration" : "assistant";
    const last = groups[groups.length - 1];
    if (last && last.kind === kind && kind === "assistant") last.blocks.push(b);
    else groups.push({ kind, blocks: [b] });
  }

  return (
    <div className="relative h-full">
    <div
      ref={containerRef}
      onScroll={onScroll}
      className="h-full overflow-y-auto px-6 py-5"
      data-message-list
    >
      <div ref={contentRef} className="mx-auto flex max-w-[820px] flex-col gap-5">
        {blocks.length === 0 && (
          <div className="mt-24 text-center">
            <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-lg bg-panel text-fg">
              <Logo size={20} />
            </div>
            <p className="text-muted">무엇을 조사하거나 고칠까요?</p>
          </div>
        )}
        {groups.map((g, i) => (
          <Group key={g.blocks[0].id + i} group={g} provider={provider} tabId={tabId} onRerunVerify={onRerunVerify} onCompareFanout={onCompareFanout} onOpenOrchestration={onOpenOrchestration} />
        ))}
        {thinking && (
          <Thinking
            withAvatar={groups[groups.length - 1]?.kind !== "assistant"}
            provider={provider}
            reasoning={reasoning}
            since={lastUserTs}
            afterTool={last?.kind === "tool" ? last.name : null}
          />
        )}
        {status !== "idle" && status !== "error" && (turnStartedAt ?? lastUserTs) !== null && <RunningFooter since={status === "queued" ? lastUserTs! : (turnStartedAt ?? lastUserTs!)} blocks={blocks} status={status} />}
        <div ref={endRef} />
      </div>
    </div>
      {!atBottom && blocks.length > 0 && (
        <button
          onClick={() => {
            stickToBottom.current = true;
            setAtBottom(true);
            scrollToBottom();
          }}
          className="absolute bottom-3 left-1/2 flex -translate-x-1/2 items-center gap-1.5 rounded-full border border-line bg-panel px-3 py-1 text-[11px] text-muted shadow-md hover:text-fg"
          title="맨 아래로 (새 내용이 오면 다시 따라갑니다)"
          data-scroll-bottom
        >
          <Icon name="arrowUp" size={11} className="rotate-180" />
          맨 아래로
        </button>
      )}
    </div>
  );
}

/**
 * 턴이 돌고 있지만 아직 말이 없는 구간의 표시. 경과 시간을 세고, 모델의 생각(reasoning)이 흘러오면 그 마지막 줄들을
 * 아래에 보여 준다 — 무엇을 따져 보고 있는지 보이면 "멈춘 것 아닌가" 하는 느낌이 줄어든다. 생각은 화면에만 흐르고 기록엔 남지 않는다.
 */
function Thinking({
  withAvatar,
  provider,
  reasoning,
  since,
  afterTool,
}: {
  withAvatar: boolean;
  provider: Provider;
  /** 지금 턴에서 흘러온 생각 텍스트의 꼬리(없으면 빈 문자열) */
  reasoning: string;
  /** 턴 시작 시각(마지막 사용자 메시지). 없으면 시간을 세지 않는다. */
  since: number | null;
  /** 도구 결과를 막 받은 뒤면 그 도구 이름(다음 행동을 정하는 구간), 아니면 null */
  afterTool: string | null;
}) {
  // 총 경과 시간은 맨 아래 RunningFooter 가 보여 주므로 여기선 라벨만
  void since;
  const tail = reasoning
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-2)
    .join("\n");
  const label = afterTool ? `${afterTool} 결과 보는 중` : "생각 중";
  return (
    <div className={`flex gap-3 ${withAvatar ? "items-start" : "-mt-3"}`} aria-live="polite" data-thinking>
      {withAvatar ? <Avatar provider={provider} /> : <div className="avatar-gap" />}
      <div className="min-w-0 flex-1">
        {/* 아바타(32px + 위 여백 2px)와 같은 높이로 두고 세로 가운데 — 생각 텍스트가 붙으면 그 아래로 이어진다 */}
        <div className={`thinking-dots flex items-center gap-1.5 text-muted ${withAvatar ? "min-h-[34px]" : ""}`}>
          {/* 라벨에 긴 MCP 도구 이름이 들어온다 — 줄어들 수 있게 하고(min-w-0), 공백이 없으면 토큰 안에서 감기게. */}
          <span className="mr-1 min-w-0 break-words text-[12.5px]">
            <span className="shimmer">{label}</span>
          </span>
          <span />
          <span />
          <span />
        </div>
        {tail && (
          // 폭 상한을 두지 않는다. 목록이 820px 로 묶여 있어 칼럼은 778px 에서 더 안 커지고,
          // 두 줄 제한이 이미 길이를 잡아 준다. 좁히면 그만큼 글만 더 잘려 나간다(실측 159자 → 188자).
          <div key={tail} className="reasoning-tail mt-1 text-[12px] leading-relaxed text-muted-2" data-thinking-text>
            {tail}
          </div>
        )}
      </div>
    </div>
  );
}

/** 턴이 도는 동안 맨 아래에 붙는 한 줄: 총 경과 시간 · 이번 턴의 도구 호출 수 · 상태. 끝나면 turn 블록의 요약이 대신한다. */
/**
 * 턴이 끝난 뒤에도 도는 작업(백그라운드 Codex 등). 탭은 "대기" 인데 일은 남아 있다는 것을 여기서만 알 수 있다 —
 * 그 프로세스는 앱에서 떨어져 나가 하위 에이전트 표시에도 안 잡힌다.
 */

function RunningFooter({ since, blocks, status }: { since: number; blocks: Block[]; status: SessionStatus }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const secs = Math.max(0, Math.floor((now - since) / 1000));
  let tools = 0;
  let running = 0;
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (b.kind === "user") break;
    if (b.kind === "tool") {
      tools += 1;
      if (!b.result) running += 1;
    }
  }
  // 권한 대기 중 AskUserQuestion 이 걸려 있으면 승인이 아니라 답을 기다리는 것
  const askingQuestion = blocks.some((b) => b.kind === "tool" && b.permission === "pending" && b.name === "AskUserQuestion");
  const label = status === "queued" ? "대기열 (요청 후)" : status === "waiting_permission" ? (askingQuestion ? "답변 대기" : "권한 대기") : running > 0 ? `도구 실행 중` : "응답 중";
  return (
    <div className="content-indent flex items-center gap-2 text-[11px] text-muted-2" data-turn-elapsed={secs}>
      <span className="spin inline-block h-2.5 w-2.5 rounded-full border-[1.5px] border-accent border-t-transparent" />
      <span className="shimmer" style={{ "--shimmer-base": "var(--color-muted)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties}>
        {label}
      </span>
      <span className="mono">{secs >= 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs}초`}</span>
      {tools > 0 && <span className="mono">· 도구 {tools}회</span>}
    </div>
  );
}

/** 어시스턴트 이름·아바타는 제공자를 따른다 (헤더의 제공자 버튼과 같은 로고). */
const ASSISTANT: Record<Provider, { label: string }> = {
  claude: { label: "Claude" },
  codex: { label: "Codex" },
};

function Avatar({ provider }: { provider: Provider }) {
  return <ProviderLogo provider={provider} size={32} className="mt-0.5" />;
}

type GroupKind = "user" | "assistant" | "compacted" | "error" | "review" | "verify" | "fanout" | "orchestration";

function Group({
  group,
  provider,
  tabId,
  onRerunVerify,
  onCompareFanout,
  onOpenOrchestration,
}: {
  group: { kind: GroupKind; blocks: Block[] };
  provider: Provider;
  tabId: string;
  onRerunVerify?: (commands: string[]) => void;
  onCompareFanout?: (fanoutId: string) => void;
  onOpenOrchestration?: (runId: string) => void;
}) {
  if (group.kind === "orchestration") {
    const b = group.blocks[0];
    return b.kind === "orchestration" ? <OrchestrationCard block={b} onOpen={(id) => onOpenOrchestration?.(id)} /> : null;
  }
  if (group.kind === "fanout") {
    const b = group.blocks[0];
    return b.kind === "fanout" ? <FanoutCard block={b} tabId={tabId} onCompare={(id) => onCompareFanout?.(id)} /> : null;
  }
  if (group.kind === "verify") {
    const b = group.blocks[0];
    return b.kind === "verify" ? <VerifyCard block={b} tabId={tabId} onRerun={onRerunVerify ? () => onRerunVerify(b.commands.map((c) => c.cmd)) : undefined} /> : null;
  }
  if (group.kind === "review") {
    const b = group.blocks[0];
    return b.kind === "review" ? <ReviewCard block={b} /> : null;
  }
  if (group.kind === "compacted") {
    const b = group.blocks[0];
    if (b.kind !== "compacted") return null;
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    return (
      <div className="flex items-center gap-3 py-1 text-[11px] text-muted" data-compacted={b.trigger}>
        <div className="h-px flex-1 bg-line" />
        <span className="shrink-0">
          {b.trigger === "auto" ? "자동 압축" : "압축"} · {k(b.preTokens)}
          {b.postTokens !== undefined ? ` → ${k(b.postTokens)}` : ""} · 위쪽 대화는 요약으로 대체됐습니다
        </span>
        <div className="h-px flex-1 bg-line" />
      </div>
    );
  }
  if (group.kind === "error") {
    const b = group.blocks[0];
    return b.kind === "error" ? (
      <div className="content-indent flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-2 text-muted">
        <Icon name="info" size={13} className="shrink-0 text-warn" />
        <span style={{ userSelect: "text" }}>{b.message}</span>
      </div>
    ) : null;
  }

  const isUser = group.kind === "user";
  const first = group.blocks[0];
  const ts = first.kind === "user" ? first.ts : null;
  const time = ts
    ? new Date(ts).toLocaleTimeString("ko-KR", {
        hour: "2-digit",
        minute: "2-digit",
      })
    : null;

  // 내 메시지는 메신저처럼 오른쪽 말풍선. 아바타·이름 없이 시각만 아래에.
  if (isUser) {
    return (
      <div className="flex flex-col items-end gap-1">
        <div className="min-w-0 max-w-[72%] rounded-2xl rounded-br-md bg-panel-2 px-4 py-2.5">
          {group.blocks.map((b) => (
            <div key={b.id} data-block-id={b.id} className="reveal-target">
              <BlockView block={b} />
            </div>
          ))}
        </div>
        {time && (
          <span className="mono pr-1 text-[10px] text-muted">{time}</span>
        )}
      </div>
    );
  }

  // 압축처럼 말 없이 끝나는 턴이 있다 — 그때는 통계 블록만 온다.
  // 이름표와 아바타를 그리면 "클로드가 무언가 말했는데 비어 있다" 로 보인다. 통계 한 줄만 남긴다.
  if (group.blocks.every((b) => b.kind === "turn")) {
    return (
      <div className="content-indent" data-silent-turn>
        {group.blocks.map((b) => (
          <div key={b.id} data-block-id={b.id}>
            <BlockView block={b} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      <Avatar provider={provider} />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-baseline gap-2">
          <span className="font-semibold">{ASSISTANT[provider].label}</span>
        </div>
        <div className="flex flex-col gap-1">
          {group.blocks.map((b) => (
            <div key={b.id} data-block-id={b.id} className="reveal-target">
              <BlockView block={b} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

function BlockView({ block }: { block: Block }) {
  switch (block.kind) {
    case "user":
      return (
        <div
          className="whitespace-pre-wrap break-words text-[13.5px] leading-relaxed"
          style={{ userSelect: "text" }}
        >
          {block.images && block.images.length > 0 && (
            <div className="mb-2 flex gap-2">
              {block.images.map((img, i) => (
                <img
                  key={i}
                  src={img.dataUrl}
                  className="h-20 rounded-md border border-line"
                  alt=""
                />
              ))}
            </div>
          )}
          {block.text}
        </div>
      );
    case "text":
      return (
        <div className="py-0.5" style={{ userSelect: "text" }}>
          <Markdown text={block.text} />
          {block.streaming && (
            <span className="ml-0.5 inline-block h-3.5 w-1.5 animate-pulse bg-accent align-middle" />
          )}
        </div>
      );
    case "tool":
      return <ToolCard block={block} />;
    case "turn": {
      const stats = (
        <span className="mono text-[10px]">
          {(block.durationMs / 1000).toFixed(1)}s · in {fmt(block.usage.input)}{" "}
          / out {fmt(block.usage.output)}
          {block.usage.cacheRead > 0 &&
            ` · cache ${fmt(block.usage.cacheRead)}`}
          {block.costUsd > 0 && ` · $${block.costUsd.toFixed(4)}`}
        </span>
      );
      // 성공한 턴은 통계 한 줄만 조용히. 실패는 원인을 봐야 하니 박스로.
      if (!block.isError)
        return <div className="mt-1 text-right text-muted-2">{stats}</div>;
      return (
        <div className="mt-1 flex items-center gap-2 rounded-md border border-err/40 bg-err-bg px-3 py-2 text-err">
          <Icon name="alert" size={13} />
          <span className="flex-1">
            {block.errorText ?? "턴이 실패했습니다."}
          </span>
          <span className="opacity-80">{stats}</span>
        </div>
      );
    }
    default:
      return null;
  }
}

function fmt(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** 교차 리뷰 카드: 요청 중엔 shimmer + 경과, 끝나면 리뷰 본문(마크다운). 리뷰 탭으로 바로 갈 수 있다. */
function ReviewCard({ block }: { block: ReviewBlock }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (block.status !== "requested") return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [block.status]);
  const name = block.reviewer === "claude" ? "Claude Code" : "Codex";
  const secs = Math.max(0, Math.floor((now - block.ts) / 1000));
  return (
    <div className="content-indent rounded-lg border border-line bg-panel" data-review-card={block.id} data-review-status={block.status}>
      <div className="flex items-center gap-2 border-b border-line px-3 py-2">
        <ProviderLogo provider={block.reviewer} size={18} />
        <span className="font-medium">교차 리뷰 · {name}</span>
        {block.scope && <span className="mono text-[10.5px] text-muted-2">{block.scope}</span>}
        <span className="flex-1" />
        {block.status === "requested" && (
          <span className="label flex items-center gap-1.5 text-accent">
            <span className="shimmer" style={{ "--shimmer-base": "var(--color-accent)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties}>
              리뷰 중
            </span>
            {secs >= 3 && <span className="mono normal-case tracking-normal text-muted-2">{secs >= 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs}초`}</span>}
          </span>
        )}
        {block.status === "done" && <span className="label text-ok">완료</span>}
        {block.status === "failed" && <span className="label text-err">실패</span>}
        <button
          onClick={() => void window.workbench.workspaces.activateTab(block.id)}
          className="rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg"
          title="리뷰가 진행된 탭으로 이동"
          data-review-open
        >
          리뷰 탭
        </button>
      </div>
      {block.status === "done" && (
        <div className="px-3 py-2.5" style={{ userSelect: "text" }}>
          <Markdown text={block.text} />
        </div>
      )}
      {block.status === "failed" && <div className="px-3 py-2 text-[12px] text-err">{block.text}</div>}
      {block.status === "requested" && <div className="px-3 py-2 text-[12px] text-muted">{name} 가 변경 사항을 살펴보고 있습니다. 끝나면 여기에 결과가 붙습니다.</div>}
    </div>
  );
}
