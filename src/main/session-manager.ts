// 탭(=세션) 관리. Map<tabId, Session>. 탭마다 AbortController, 이벤트 로그, 대기 중인 권한 요청을 든다.
// provider 어댑터는 이벤트만 흘리고, 이 매니저가 renderer 로 보내는 emit 을 소유한다.
// 동시 실행 상한(기본 4)을 넘으면 큐에 넣고 status=queued 로 알린다.

import type {
  ChatEvent,
  PermissionAnswer,
  PermissionPolicy,
  PermissionRequestEvent,
  SessionStatus,
} from "@shared/chat-events";
import { buildHandoff, type Handoff } from "@shared/handoff";
import type { Provider, ProviderRateLimitDto } from "@shared/ipc";
import type { SlashCommandDto } from "@shared/slash-commands";
import type { StoredChatImage } from "./chat-attachments";
import { closeAllClaudeSessions, closeClaudeSession, runClaudeTurn, warmClaudeSession, type ClaudeRuntime } from "./claude-adapter";
import { closeAllCodexSessions, closeCodexSession, runCodexTurn, warmCodexSession, type CodexRuntime } from "./codex-adapter";
import { randomUUID } from "node:crypto";
import {
  isUsageLimitText,
  USAGE_LIMIT_MAX_RETRIES,
  usageLimitRetryAt,
} from "@shared/usage-limit";
import type { LimitWaitDto, QueueInfoDto } from "@shared/ipc";
import fs from "node:fs";
import path from "node:path";
import { CompanionMirror } from "./companion-mirror";
import { staleRunEvents } from "@shared/stale-runs";
import {
  TranscriptWatcher,
  findClaudeTranscript,
  findCodexRollout,
  mapClaudeHookLine,
  mapClaudeTranscriptLine,
  mapCodexRolloutLine,
  newMirrorState,
  readCodexRolloutMeta,
  type HookEvent,
} from "./transcript-mirror";
import { CodexApprovalDetector } from "./codex-approval";

/** 세션을 누가 제어하는가. "terminal" 이면 CLI(TUI)가 pty 에서 돌고 앱은 기록 파일을 미러만 한다. */
export type SessionController = "app" | "terminal";

/** 터미널 모드에서 CLI 가 사용자 입력을 기다리는 상황. 지금은 권한 다이얼로그만 (Claude 훅으로 감지). */
export interface TerminalAttention {
  kind: "permission";
  tool: string;
  /** 사람이 읽을 한 줄 요약 (Bash 는 명령, 파일 툴은 경로). */
  summary: string;
  since: number;
}

export interface SessionConfig {
  provider: Provider;
  cwd: string | null;
  policy: PermissionPolicy;
  model?: string;
  sessionId?: string | null;
}

export interface SessionSnapshot {
  tabId: string;
  provider: Provider;
  cwd: string | null;
  policy: PermissionPolicy;
  model?: string;
  status: SessionStatus;
  sessionId: string | null;
  /** provider 전환 후 아직 첫 메시지를 보내지 않아 요약이 대기 중이면 true. */
  handoffPending: boolean;
  startedAt: number | null;
  /** 지금 도는 턴이 실제로 시작된 시각(큐 대기 제외). 턴이 끝나면 null. */
  turnStartedAt: number | null;
  controller: SessionController;
  terminalAttention: TerminalAttention | null;
  /** controller=terminal 인데 앱이 띄운 CLI 가 아니라 통합 터미널에서 사용자가 직접 띄운 것이면 true(끊기 버튼 없음). */
  terminalExternal: boolean;
  pendingPrompts: PendingPromptSummary[];
  limitWait: LimitWaitDto | null;
  /** status=queued 일 때 왜 기다리는지: 대기 순번, 진행 중 턴 수(승인 대기 포함)와 상한. */
  queueInfo: QueueInfoDto | null;
}

interface QueuedTurn {
  text: string;
  prompt: string;
  images: StoredChatImage[];
}

/** 사용자가 턴 진행 중에 써 둔 다음 지시. 턴이 정상 종료되면 순서대로 자동 전송된다. */
export interface PendingPrompt {
  id: string;
  text: string;
  images: StoredChatImage[];
  userEvent: ChatEvent;
}

export interface PendingPromptSummary {
  id: string;
  text: string;
  hasImages: boolean;
}

interface Session {
  tabId: string;
  provider: Provider;
  cwd: string | null;
  policy: PermissionPolicy;
  model?: string;
  status: SessionStatus;
  sessionId: string | null;
  abort: AbortController | null;
  pending: Map<string, (answer: PermissionAnswer) => void>;
  /** 대기 중인 권한 요청 본문(requestId → 이벤트). 교차 리뷰처럼 사람이 안 보는 탭을 main 이 대신 판정할 때 본다. */
  pendingReqs: Map<string, PermissionRequestEvent>;
  /** null 이면 아직 디스크에서 읽지 않았다 (lazy). */
  events: ChatEvent[] | null;
  /** provider 전환 시 다음 프롬프트 앞에 붙일 요약. 한 번 쓰고 비운다. */
  handoffPrefix: string | null;
  startedAt: number | null;
  /** 지금 도는 턴이 실제로 시작된 시각(큐 대기 제외). 턴이 끝나면 null. */
  turnStartedAt: number | null;
  queued: QueuedTurn | null;
  /** 프롬프트 큐 (턴 진행 중 써 둔 다음 지시들). */
  promptQueue: PendingPrompt[];
  /** 한도 도달로 실패한 턴의 재시도 예약. */
  limitWait: (LimitWaitDto & { turn: QueuedTurn; timer: ReturnType<typeof setTimeout> | null }) | null;
  /** 재시도 중인 턴의 누적 시도 횟수(재시도 시작 시 limitWait 에서 옮겨 둔다). */
  limitAttempts: number;
  controller: SessionController;
  /** 터미널 모드 동안 기록 파일을 tail 하는 워처. */
  mirror: TranscriptWatcher | null;
  /** 터미널 모드(Claude) 동안 훅 로그를 tail 하는 워처와 그 파일. */
  hookWatcher: TranscriptWatcher<HookEvent> | null;
  hookLog: string | null;
  attention: TerminalAttention | null;
  /** 터미널 모드(Codex) 동안 pty 출력에서 승인 프롬프트를 찾는 감지기. */
  codexApproval: CodexApprovalDetector | null;
  /** 통합 터미널(사용자 셸)에서 직접 띄운 CLI 가 세션을 잡고 있다: 앱이 띄운 게 아니라 끊을 수도, 훅을 걸 수도 없다. 기록 파일 미러만. */
  external: { pid: number; cwd: string; watch: ReturnType<typeof setInterval> | null; since: number } | null;
  /** Skill·Agent 카드가 열려 있는 동안 codex-companion 이 띄운 Codex 의 rollout 을 tail 해 카드에 흘린다(화면 전용). */
  companion: CompanionMirror | null;
}

/** 탭의 살아 있는 provider 프로세스(Claude·Codex)를 모두 내린다. */
function closeProviderSessions(tabId: string) {
  closeClaudeSession(tabId);
  closeCodexSession(tabId);
}

export interface SessionStore {
  appendEvent(tabId: string, event: ChatEvent): void;
  readEvents(tabId: string): ChatEvent[];
  resetThread(tabId: string): void;
  /** 프롬프트 큐 영속화(선택). 없으면 큐는 메모리에만 산다. */
  savePromptQueue?(tabId: string, items: PendingPrompt[]): void;
  loadPromptQueue?(tabId: string): PendingPrompt[];
}

export interface SessionManagerDeps {
  emit(tabId: string, event: ChatEvent): void;
  claudeRuntime(): Promise<ClaudeRuntime>;
  codexRuntime(): Promise<CodexRuntime>;
  store?: SessionStore;
  /** 모르는 tabId 를 만났을 때 영속 모델에서 설정을 가져온다. */
  resolveConfig?(tabId: string): SessionConfig | null;
  /** 제목·sessionId·설정 변경을 영속 모델에 반영하도록 알린다. */
  onMeta?(
    tabId: string,
    patch: {
      title?: string;
      sessionId?: string | null;
      provider?: Provider;
      model?: string;
      policy?: PermissionPolicy;
      cwd?: string | null;
    },
  ): void;
  onStatus?(tabId: string, status: SessionStatus): void;
  maxConcurrent?: number;
  log?(tabId: string, line: string): void;
  /** 설정의 예열 스위치. false 면 warm() 은 아무것도 안 한다(턴은 정상 경로로 프로세스를 띄운다). */
  warmEnabled?(): boolean;
  /** Claude 턴 도중 알게 된 슬래시 커맨드 정보를 cwd 별 캐시에 반영한다. */
  onSlashCommands?(
    cwd: string,
    patch: { commands?: SlashCommandDto[]; terminal?: string[] },
  ): void;
  /** 턴 중 관측한 구독 한도(5시간/주간 창). */
  onRateLimit?(provider: Provider, limit: ProviderRateLimitDto): void;
  /** 터미널 모드: 이 탭의 pty 에 CLI 를 띄우고(spawn), 강제 종료(kill)한다. 종료는 terminalExited 로 알려 준다. */
  terminalCli?: {
    /** hookLog 가 있으면(Claude) CLI 에 훅을 주입해 그 파일로 이벤트를 남기게 한다. */
    spawn(
      tabId: string,
      provider: Provider,
      cwd: string,
      sessionId: string | null,
      isNew: boolean,
      hookLog: string | null,
    ): Promise<void>;
    kill(tabId: string): void;
  };
  /** 기록 파일 루트 (~/.claude/projects, ~/.codex/sessions). */
  transcriptRoots?: { claude: string; codex: string };
  /** 터미널 모드 훅 로그를 둘 디렉토리. 없으면 권한 대기 힌트를 끈다. */
  hookLogDir?: string;
  /** 컨트롤러 전환처럼 main 쪽에서 스냅샷이 바뀌었을 때 renderer 에 밀어 준다. */
  onSnapshot?(tabId: string, snapshot: SessionSnapshot): void;
}

const MAX_PROMPT_QUEUE = 20;

/** Claude 가 cwd 에 대응시키는 projects/ 하위 디렉토리 이름: 경로의 / 와 . 을 - 로. 심링크·정규화 차이를 대비해 realpath 것도 함께 본다. */
function claudeProjectDirs(root: string, cwd: string): string[] {
  const key = (p: string) => path.join(root, p.replace(/[\/.]/g, "-"));
  const out = [key(cwd)];
  try {
    const real = fs.realpathSync(cwd);
    if (real !== cwd) out.push(key(real));
  } catch {
    /* 없는 경로 */
  }
  return out;
}

/** 하위 에이전트를 띄우는 도구 — 이 카드가 열려 있는 동안 companion Codex 를 찾는다. */
const AGENT_TOOLS = new Set(["Skill", "Agent", "Task"]);

export const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

export class SessionManager {
  private readonly sessions = new Map<string, Session>();
  private readonly queue: string[] = [];
  private maxConcurrent: number;

  constructor(private readonly deps: SessionManagerDeps) {
    this.maxConcurrent = Math.max(1, deps.maxConcurrent ?? 4);
  }

  /** 동시 실행 상한을 바꾼다. 올리면 기다리던 턴을 바로 시작하고, 내려도 진행 중인 턴은 그대로 둔다(새 시작만 막힘). */
  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /** 동시 작업 수에서 빼는 탭(오케스트레이션 코디네이터 — 인박스를 기다리는 동안 워커 자리를 막지 않게). */
  private exemptTabs = new Set<string>();
  setExemptTabs(ids: Iterable<string>): void {
    this.exemptTabs = new Set(ids);
    this.drain();
  }

  setMaxConcurrent(n: number): void {
    this.maxConcurrent = Math.max(1, Math.round(n));
    this.drain();
    this.broadcastQueued();
  }

  private queueInfo(tabId: string): QueueInfoDto | null {
    const i = this.queue.indexOf(tabId);
    if (i === -1) return null;
    let running = 0;
    let waitingPermission = 0;
    for (const s of this.sessions.values()) {
      if (s.status === "running") running += 1;
      else if (s.status === "waiting_permission") {
        running += 1;
        waitingPermission += 1;
      }
    }
    return { position: i + 1, running, max: this.maxConcurrent, waitingPermission };
  }

  /** 진행 중 수나 대기 순번이 바뀌면 기다리는 탭들의 표시를 갱신한다. */
  private broadcastQueued() {
    for (const tabId of this.queue) this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
  }

  ensure(tabId: string, defaults?: Partial<SessionConfig>): Session {
    let s = this.sessions.get(tabId);
    if (!s) {
      const resolved = this.deps.resolveConfig?.(tabId) ?? null;
      s = {
        tabId,
        provider: defaults?.provider ?? resolved?.provider ?? "claude",
        cwd: defaults?.cwd ?? resolved?.cwd ?? null,
        policy: defaults?.policy ?? resolved?.policy ?? "ask",
        model: defaults?.model ?? resolved?.model,
        status: "idle",
        sessionId: defaults?.sessionId ?? resolved?.sessionId ?? null,
        abort: null,
        pending: new Map(),
        pendingReqs: new Map(),
        events: null,
        handoffPrefix: null,
        startedAt: null,
        turnStartedAt: null,
        queued: null,
        // 지난 실행(또는 닫았던 탭)에서 남은 대기 지시를 복원한다. 자동으로 보내지는 않고, 다음 턴이 끝나거나 "지금 보내기" 로 나간다.
        promptQueue: this.deps.store?.loadPromptQueue?.(tabId) ?? [],
        limitWait: null,
        limitAttempts: 0,
        controller: "app",
        mirror: null,
        hookWatcher: null,
        hookLog: null,
        attention: null,
        codexApproval: null,
        external: null,
        companion: null,
      };
      this.sessions.set(tabId, s);
    }
    return s;
  }

  snapshot(tabId: string): SessionSnapshot {
    const s = this.ensure(tabId);
    return {
      tabId,
      provider: s.provider,
      cwd: s.cwd,
      policy: s.policy,
      model: s.model,
      status: s.status,
      sessionId: s.sessionId,
      handoffPending: s.handoffPrefix !== null,
      startedAt: s.startedAt,
      turnStartedAt: s.turnStartedAt,
      controller: s.controller,
      terminalAttention: s.attention,
      terminalExternal: s.external !== null,
      pendingPrompts: s.promptQueue.map((p) => ({ id: p.id, text: p.text, hasImages: p.images.length > 0 })),
      limitWait: s.limitWait
        ? { until: s.limitWait.until, attempts: s.limitWait.attempts, message: s.limitWait.message }
        : null,
      queueInfo: s.status === "queued" ? this.queueInfo(tabId) : null,
    };
  }

  // ===== 사용 한도 도달 → 자동 재시도 =====

  /**
   * 턴이 한도 오류로 끝났다: 그 턴을 보관하고 리셋 시각에 다시 보낸다(사용자 메시지는 다시 기록하지 않음).
   * 리셋 시각을 모르면 예약 없이 배너만 띄운다(수동 재시도). 상한을 넘으면 예약하지 않는다.
   */
  private scheduleLimitRetry(s: Session, turn: QueuedTurn, message: string, rejectedResetsAt: number | null) {
    const attempts = (s.limitWait?.attempts ?? 0) + 1;
    this.clearLimitTimer(s);
    const until = attempts <= USAGE_LIMIT_MAX_RETRIES ? usageLimitRetryAt(message, rejectedResetsAt, Date.now()) : null;
    const tabId = s.tabId;
    s.limitWait = {
      until,
      attempts,
      message: message.split("\n")[0].slice(0, 200),
      turn,
      timer: until ? setTimeout(() => this.limitRetryNow(tabId), until - Date.now() + 5_000) : null,
    };
    this.record(s, {
      type: "error",
      ts: Date.now(),
      fatal: false,
      message: until
        ? `사용 한도에 도달했습니다. ${new Date(until).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })} 에 자동으로 다시 시도합니다 (${attempts}번째).`
        : attempts > USAGE_LIMIT_MAX_RETRIES
          ? `사용 한도에 도달했습니다. 자동 재시도 ${USAGE_LIMIT_MAX_RETRIES}회를 넘겨 멈춥니다.`
          : "사용 한도에 도달했습니다. 리셋 시각을 알 수 없어 자동 재시도는 예약하지 않았습니다.",
    });
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
  }

  private clearLimitTimer(s: Session) {
    if (s.limitWait?.timer) clearTimeout(s.limitWait.timer);
    if (s.limitWait) s.limitWait.timer = null;
  }

  /** 지금 바로 다시 시도 (예약 시각 전이라도). 실행 중이면 무시. */
  limitRetryNow(tabId: string): SessionSnapshot {
    const s = this.sessions.get(tabId);
    if (!s) return this.snapshot(tabId);
    const wait = s.limitWait;
    if (!wait) return this.snapshot(tabId);
    this.clearLimitTimer(s);
    if (this.isBusy(tabId) || s.controller !== "app") {
      // 지금은 보낼 수 없다(다른 턴 실행 중·터미널 모드): 타이머를 짧게 다시 걸어 놓친 채로 남지 않게 한다.
      wait.timer = setTimeout(() => this.limitRetryNow(tabId), 30_000);
      return this.snapshot(tabId);
    }
    // attempts 는 다음 실패 때 이어 세도록 옮겨 두고, limitWait 는 지운다(실패하면 scheduleLimitRetry 가 다시 만든다).
    s.limitAttempts = wait.attempts;
    s.limitWait = null;
    s.queued = wait.turn;
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    // 동시 실행 상한은 일반 전송과 같이 지킨다(예외 탭은 바로 시작).
    if (!this.canStart(tabId)) {
      this.queue.push(tabId);
      this.setStatus(s, "queued");
    } else this.start(s);
    return this.snapshot(tabId);
  }

  limitCancel(tabId: string): SessionSnapshot {
    const s = this.sessions.get(tabId);
    if (!s) return this.snapshot(tabId);
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    }
    return this.snapshot(tabId);
  }

  // ===== 프롬프트 큐 =====

  queueRemove(tabId: string, id: string): SessionSnapshot {
    const s = this.ensure(tabId);
    const n = s.promptQueue.length;
    s.promptQueue = s.promptQueue.filter((p) => p.id !== id);
    if (s.promptQueue.length !== n) {
      this.persistQueue(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    }
    return this.snapshot(tabId);
  }

  queueUpdate(tabId: string, id: string, text: string): SessionSnapshot {
    const s = this.ensure(tabId);
    const p = s.promptQueue.find((x) => x.id === id);
    if (p) {
      p.text = text;
      if (p.userEvent.type === "user_message") p.userEvent = { ...p.userEvent, text };
      this.persistQueue(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    }
    return this.snapshot(tabId);
  }

  /**
   * 예열: 탭이 활성화되거나 cwd 가 정해졌을 때 Claude 프로세스를 미리 띄워 첫 턴도 웜으로 시작하게 한다.
   * Claude·앱 제어·cwd 있음·턴 없음일 때만. 실패는 조용히 로그만(다음 턴이 정상 경로로 다시 띄운다).
   */
  async warm(tabId: string): Promise<void> {
    if (this.deps.warmEnabled && !this.deps.warmEnabled()) return;
    const s = this.ensure(tabId);
    if (!s.cwd || s.controller !== "app" || this.isBusy(tabId)) return;
    const req = { sessionKey: tabId, cwd: s.cwd, sessionId: s.sessionId, policy: s.policy, model: s.model, log: (line: string) => this.deps.log?.(tabId, line) };
    try {
      if (s.provider === "claude") {
        const r = await warmClaudeSession(await this.deps.claudeRuntime(), req);
        if (r === "opened") this.deps.log?.(tabId, "[claude] 예열 시작");
      } else {
        const r = await warmCodexSession(await this.deps.codexRuntime(), req);
        if (r === "opened") this.deps.log?.(tabId, "[codex] 예열 시작");
      }
    } catch (e) {
      this.deps.log?.(tabId, `[${s.provider}] 예열 실패: ${describeError(e)}`);
    }
  }

  /** 세션이 놀고 있을 때(복원됐거나 오류로 끝난 뒤) 큐 맨 앞을 지금 보낸다. 진행 중이면 아무것도 안 한다. */
  queueSendNext(tabId: string): SessionSnapshot {
    const s = this.ensure(tabId);
    // 사용자가 직접 누른 것이므로 오류로 멈춘 상태에서도 보낸다(자동 drain 은 정상 종료 뒤에만).
    this.drainPending(s, { allowError: true });
    return this.snapshot(tabId);
  }

  private persistQueue(s: Session) {
    this.deps.store?.savePromptQueue?.(s.tabId, s.promptQueue);
  }

  /** 턴이 정상 종료됐을 때: 큐 맨 앞을 보낸다. 오류로 끝났으면 멈춰 두고 사용자에게 맡긴다(allowError 는 "지금 보내기" 전용). */
  private drainPending(s: Session, opts: { allowError?: boolean } = {}) {
    // release() 로 내려간 세션 객체(탭 닫기·삭제)는 더 이상 이 매니저의 것이 아니다 — 큐를 소비하지 않고 디스크에 남긴다.
    if (this.sessions.get(s.tabId) !== s) return;
    const restable = s.status === "idle" || (opts.allowError && s.status === "error");
    if (s.controller !== "app" || s.limitWait || !restable || s.promptQueue.length === 0 || this.isBusy(s.tabId)) return;
    const next = s.promptQueue.shift()!;
    this.persistQueue(s);
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
    void this.send(s.tabId, next.text, next.images, { ...next.userEvent, ts: Date.now() }).then((r) => {
      // 보낼 수 없었으면(작업 경로 없음 등) 조용히 버리지 않고 남긴다.
      if (!r.ok)
        this.record(s, {
          type: "error",
          ts: Date.now(),
          fatal: false,
          message: `대기열의 지시를 보내지 못했습니다: ${r.error}\n${next.text.slice(0, 200)}`,
        });
    });
  }

  // ===== 터미널 모드 (하이브리드): 같은 세션 id 를 앱과 CLI 가 번갈아 잡는다 =====

  /**
   * 세션 제어를 터미널로 넘긴다. Claude 는 세션 id 가 없으면 지금 만들어 --session-id 로 넘기고(나중에 SDK resume 가능),
   * Codex 는 새 세션이면 rollout 파일이 생긴 뒤 그 id 를 가져온다. 기록 파일 미러는 CLI 가 종료될 때까지 돈다.
   */
  async attachTerminal(
    tabId: string,
  ): Promise<
    { ok: true; snapshot: SessionSnapshot } | { ok: false; error: string }
  > {
    const s = this.ensure(tabId);
    if (s.controller === "terminal")
      return { ok: true, snapshot: this.snapshot(tabId) };
    if (this.isBusy(tabId))
      return {
        ok: false,
        error: "실행 중인 턴이 끝난 뒤에 터미널로 넘길 수 있습니다.",
      };
    if (!s.cwd) return { ok: false, error: "작업 디렉토리를 먼저 정하세요." };
    if (!this.deps.terminalCli)
      return { ok: false, error: "터미널 모드를 쓸 수 없습니다." };
    // 같은 세션 id 에 앱의 SDK 프로세스와 CLI 가 동시에 붙으면 안 된다 — 살아 있던 프로세스를 먼저 내린다.
    closeProviderSessions(tabId);
    const isNew = !s.sessionId;
    if (s.provider === "claude" && !s.sessionId) {
      s.sessionId = randomUUID();
      this.deps.onMeta?.(tabId, { sessionId: s.sessionId });
    }
    s.controller = "terminal";
    s.handoffPrefix = null;
    // 터미널이 세션을 잡는 동안 앱의 자동 재시도는 의미가 없다 — 예약을 지운다(큐는 돌아오면 이어 간다).
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
    }
    s.hookLog = this.prepareHookLog(s);
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    try {
      await this.deps.terminalCli.spawn(
        tabId,
        s.provider,
        s.cwd,
        s.sessionId,
        isNew,
        s.hookLog,
      );
    } catch (e) {
      s.controller = "app";
      this.stopHookWatcher(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
      return { ok: false, error: describeError(e) };
    }
    this.startMirror(s, isNew);
    this.startHookWatcher(s);
    return { ok: true, snapshot: this.snapshot(tabId) };
  }

  /** Claude 만: 세션 id 이름의 빈 훅 로그를 만든다. id 가 파일 이름으로 안전한 형식(UUID 등)이 아니면 힌트를 끈다. */
  private prepareHookLog(s: Session): string | null {
    const dir = this.deps.hookLogDir;
    if (!dir || s.provider !== "claude" || !s.sessionId) return null;
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(s.sessionId)) return null;
    try {
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${s.sessionId}.jsonl`);
      fs.writeFileSync(file, "");
      return file;
    } catch {
      return null;
    }
  }

  private startHookWatcher(s: Session) {
    if (!s.hookLog) return;
    const tabId = s.tabId;
    s.hookWatcher = new TranscriptWatcher<HookEvent>({
      resolveFile: () => s.hookLog,
      map: (line) => mapClaudeHookLine(line),
      skipExisting: false,
      intervalMs: 400,
      onEvents: (events) => {
        const cur = this.sessions.get(tabId);
        if (!cur || cur.controller !== "terminal") return;
        for (const e of events) this.applyHookEvent(cur, e);
      },
    });
    s.hookWatcher.start();
  }

  private applyHookEvent(s: Session, e: HookEvent) {
    if (e.type === "permission_request") {
      this.setAttention(s, {
        kind: "permission",
        tool: e.tool,
        summary: summarizeToolInput(e.tool, e.input),
        since: e.ts,
      });
    } else if (e.type === "tool_done") {
      // 같은 툴이 끝났을 때만 (병렬로 돌던 다른 툴의 종료가 대기 표시를 지우지 않게)
      if (s.attention && s.attention.tool === e.tool) this.setAttention(s, null);
    } else if (e.type === "stop") {
      this.setAttention(s, null);
    } else if (e.type === "session") {
      // TUI 안에서 /resume 등으로 다른 세션에 갈아탔다: 그 세션의 지금까지 대화를 채팅에 불러오고, 그 뒤부터 미러를 이어 간다.
      if (s.provider !== "claude" || e.sessionId === s.sessionId) return;
      const roots = this.deps.transcriptRoots;
      const file =
        e.transcriptPath && fs.existsSync(e.transcriptPath) ? e.transcriptPath : roots ? findClaudeTranscript(roots.claude, e.sessionId) : null;
      this.switchToTranscript(s, e.sessionId, file, e.ts, "터미널에서");
    }
  }

  /**
   * 세션을 갈아탄다(TUI 의 /resume, 통합 터미널에서 직접 띄운 CLI 등): 그 세션의 지금까지 기록을 채팅에 불러오고,
   * 안내 한 줄을 사이에 두고, 미러는 읽은 바이트 뒤부터 잇는다. 이 탭의 기존 기록은 지우지 않는다. 탭의 세션 id 는 새 것으로.
   */
  private switchToTranscript(s: Session, sessionId: string, file: string | null, ts: number, where: string) {
    s.mirror?.stop();
    s.mirror = null;
    const history = file ? this.readTranscript(file, s.provider) : { events: [], bytes: 0 };
    const turns = history.events.filter((h) => h.type === "user_message").length;
    s.sessionId = sessionId;
    this.deps.onMeta?.(s.tabId, { sessionId });
    this.record(s, {
      type: "error",
      ts,
      fatal: false,
      message: `${where} 다른 세션(${sessionId.slice(0, 8)})으로 갈아탔습니다. ${turns > 0 ? `그 세션의 이전 대화 ${turns}턴을 아래에 불러왔고, ` : ""}이어지는 대화도 여기 표시됩니다.`,
    });
    for (const h of history.events) this.record(s, h);
    this.record(s, { type: "session", ts, sessionId, provider: s.provider });
    this.startMirror(s, false, file, file ? history.bytes : null);
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
  }

  // ===== 통합 터미널에서 직접 띄운 CLI =====

  /**
   * 사용자 셸(통합 터미널)에서 claude/codex 가 떴다. 탭이 놀고 있고 provider 가 맞으면 터미널 모드(외부)로 들어가
   * 그 CLI 가 쓰는 기록 파일을 찾아 미러한다. 어느 파일인지는 모르므로 "감지 이후에 바뀐 가장 최근 파일" 을 따라간다
   * (/resume 으로 옛 세션을 이어도 첫 프롬프트부터 그 파일이 바뀐다). 파일이 바뀌면 그 세션의 이전 대화를 불러온다.
   */
  externalCliStarted(tabId: string, provider: Provider, cwd: string, pid: number, resumeId: string | null = null): void {
    const s = this.ensure(tabId);
    if (s.controller !== "app" || this.isBusy(tabId) || s.external) return;
    if (s.provider !== provider) {
      // 조용히 넘기면 "터미널에서 띄웠는데 채팅에 아무것도 안 뜬다" 로 보인다 — 이유를 채팅에 남긴다.
      this.record(s, {
        type: "error",
        ts: Date.now(),
        fatal: false,
        message: `터미널에서 ${PROVIDER_LABEL[provider]} 를 띄웠지만 이 세션은 ${PROVIDER_LABEL[s.provider]} 입니다. 헤더에서 ${PROVIDER_LABEL[provider]} 로 바꾸면 그 대화가 여기에도 표시됩니다.`,
      });
      return;
    }
    const roots0 = this.deps.transcriptRoots;
    if (!roots0) return;
    closeProviderSessions(tabId); // 같은 세션에 앱 프로세스와 CLI 가 같이 붙지 않게
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
    }
    s.controller = "terminal";
    s.handoffPrefix = null;
    s.external = { pid, cwd, watch: null, since: Date.now() - 2000 };
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    // 명령에 세션 id 가 있으면(`codex resume <id>`) 바로 그 세션을 붙인다 —
    // 첫 턴을 보내기 전에는 기록 파일이 그대로라 "최근에 바뀐 파일" 로는 찾을 수 없다.
    if (resumeId && resumeId !== s.sessionId) {
      const file =
        provider === "codex" ? findCodexRollout(roots0.codex, { sessionId: resumeId }) : findClaudeTranscript(roots0.claude, resumeId);
      if (file) this.switchToTranscript(s, resumeId, file, Date.now(), "터미널에서");
      else this.deps.log?.(tabId, `[external] resume 세션 ${resumeId} 의 기록 파일을 찾지 못했습니다`);
    }
    const tick = () => {
      const cur = this.sessions.get(tabId);
      if (!cur || cur.external === null) return;
      const found = this.newestTranscriptSince(cur.provider, cur.external.cwd, cur.external.since);
      if (!found || found.sessionId === cur.sessionId) return;
      this.switchToTranscript(cur, found.sessionId, found.file, Date.now(), "터미널에서");
    };
    s.external.watch = setInterval(tick, 1000);
    tick();
  }

  /** 그 CLI 프로세스가 끝났다(또는 셸이 닫혔다): 제어를 앱으로 돌린다. 세션 id 는 그대로 — 채팅에서 이어 보내면 그 세션이 계속된다. */
  externalCliExited(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || !s.external) return;
    if (s.external.watch) clearInterval(s.external.watch);
    s.external = null;
    s.mirror?.stop();
    s.mirror = null;
    s.attention = null;
    s.controller = "app";
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    this.deps.onStatus?.(tabId, s.status);
    this.drainPending(s);
  }

  /** 감지 시각 이후에 쓰인 가장 최근 기록 파일. Claude 는 cwd 의 프로젝트 디렉토리, Codex 는 rollout 탐색. */
  private newestTranscriptSince(provider: Provider, cwd: string, since: number): { sessionId: string; file: string } | null {
    const roots = this.deps.transcriptRoots;
    if (!roots) return null;
    if (provider === "codex") {
      const file = findCodexRollout(roots.codex, { cwd, after: since });
      const id = file ? readCodexRolloutMeta(file)?.sessionId : null;
      return file && id ? { sessionId: id, file } : null;
    }
    let best: { sessionId: string; file: string; mtime: number } | null = null;
    for (const dir of claudeProjectDirs(roots.claude, cwd)) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const n of names) {
        if (!n.endsWith(".jsonl")) continue;
        const file = path.join(dir, n);
        let mtime: number;
        try {
          mtime = fs.statSync(file).mtimeMs;
        } catch {
          continue;
        }
        if (mtime < since) continue;
        if (!best || mtime > best.mtime) best = { sessionId: n.slice(0, -6), file, mtime };
      }
    }
    return best ? { sessionId: best.sessionId, file: best.file } : null;
  }

  /** 기록 파일 전체를 채팅 이벤트로 바꾼다. bytes 는 읽은 길이 — 미러가 그 뒤부터 잇게. */
  private readTranscript(file: string, provider: Provider): { events: ChatEvent[]; bytes: number } {
    let buf: Buffer;
    try {
      buf = fs.readFileSync(file);
    } catch {
      return { events: [], bytes: 0 };
    }
    const text = buf.toString("utf8");
    const lastNl = text.lastIndexOf("\n");
    // 줄 경계까지만 — 쓰다 만 마지막 줄은 미러가 마저 읽는다
    const whole = lastNl === -1 ? "" : text.slice(0, lastNl + 1);
    const state = newMirrorState();
    const map = provider === "codex" ? mapCodexRolloutLine : mapClaudeTranscriptLine;
    const events: ChatEvent[] = [];
    for (const line of whole.split("\n")) if (line.trim()) events.push(...map(line, state));
    return { events, bytes: Buffer.byteLength(whole, "utf8") };
  }

  /** 미러된 tool_result 가 대기 중인 툴의 것인지 — 기록의 tool_use 이름으로 대조한다. */
  private resultMatchesAttention(s: Session, toolUseId: string): boolean {
    if (!s.attention) return false;
    const use = (s.events ?? []).find(
      (e) => e.type === "tool_use" && e.toolUseId === toolUseId,
    );
    return !use || (use.type === "tool_use" && use.name === s.attention.tool);
  }

  private setAttention(s: Session, next: TerminalAttention | null) {
    if (s.attention === next) return;
    if (
      s.attention &&
      next &&
      s.attention.tool === next.tool &&
      s.attention.summary === next.summary
    )
      return;
    s.attention = next;
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
  }

  /**
   * 터미널 모드 CLI 의 pty 출력. Codex 는 훅이 없어 화면 문구로 승인 프롬프트를 알아낸다(Claude 는 훅 로그가 담당하므로 무시).
   * "Approved action:" 이 찍히면 답한 것으로 보고 내린다.
   */
  terminalOutput(tabId: string, data: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal" || s.provider !== "codex") return;
    s.codexApproval ??= new CodexApprovalDetector();
    const signal = s.codexApproval.push(data);
    if (!signal) return;
    if (signal.kind === "prompt") this.setAttention(s, signal.attention);
    else this.setAttention(s, null);
  }

  /**
   * 사용자가 CLI pty 에 친 입력. 권한 다이얼로그가 떠 있을 때 Enter/Esc/번호/y/n 은 답한 것으로 보고 힌트를 내린다.
   * 훅은 "떴다" 만 알려 주고 "허용했다" 는 알려 주지 않아서(툴이 끝나야 PostToolUse) 이 휴리스틱으로 빈틈을 메운다.
   */
  terminalInput(tabId: string, data: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal" || !s.attention) return;
    // 단독 ESC 만 취소로 본다 — 방향키(\x1b[A)·마우스 리포트 같은 ESC 시퀀스는 아직 답한 게 아니다.
    if (data === "\x1b" || /[\r\n]/.test(data) || /^[0-9yYnN]$/.test(data))
      this.setAttention(s, null);
  }

  /** 사용자가 "채팅으로 돌아가기" 를 눌렀을 때: CLI 를 끊는다. 실제 복귀는 terminalExited 에서. */
  detachTerminal(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal" || s.external) return;
    this.deps.terminalCli?.kill(tabId);
  }

  /** pty 의 CLI 프로세스가 끝났다: 마지막으로 기록을 따라잡고 제어를 앱으로 되돌린다. */
  terminalExited(tabId: string): void {
    const s = this.sessions.get(tabId);
    if (!s || s.controller !== "terminal") return;
    s.mirror?.stop();
    const file = s.mirror?.currentFile() ?? null;
    s.mirror = null;
    this.stopHookWatcher(s);
    s.attention = null;
    s.codexApproval = null;
    s.controller = "app";
    // CLI 가 첫 메시지 전에 끝나면 기록 파일이 없다 → 그 id 로 SDK resume 하면 실패하므로 새 세션으로 돌린다.
    if (s.sessionId && !file) {
      const roots = this.deps.transcriptRoots;
      const exists =
        roots &&
        (s.provider === "claude"
          ? findClaudeTranscript(roots.claude, s.sessionId) !== null
          : findCodexRollout(roots.codex, { sessionId: s.sessionId }) !== null);
      if (!exists) {
        s.sessionId = null;
        this.deps.onMeta?.(tabId, { sessionId: null });
      }
    }
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    this.deps.onStatus?.(tabId, s.status);
    // 터미널 구간 동안 써 둔 다음 지시가 있으면 이어서 보낸다.
    this.drainPending(s);
  }

  private stopHookWatcher(s: Session) {
    s.hookWatcher?.stop();
    s.hookWatcher = null;
    if (s.hookLog) {
      try {
        fs.rmSync(s.hookLog, { force: true });
      } catch {
        /* 무시 */
      }
      s.hookLog = null;
    }
  }

  /** fileHint: 훅이 알려 준 기록 파일 경로. 있으면 그걸 우선 쓴다(projects/ 아래 어느 키 디렉토리에 있든). startOffset: 그 파일에서 이미 읽어 들인 길이. */
  private startMirror(s: Session, isNew: boolean, fileHint: string | null = null, startOffset: number | null = null) {
    const roots = this.deps.transcriptRoots;
    if (!roots) return;
    const startedAt = Date.now();
    const tabId = s.tabId;
    const onEvents = (events: ChatEvent[]) => {
      const cur = this.sessions.get(tabId);
      if (!cur || cur.controller !== "terminal") return;
      const hadUser = this.events(tabId).some((e) => e.type === "user_message");
      for (const e of events) {
        this.record(cur, e);
        if (!hadUser && e.type === "user_message" && e.text.trim())
          this.deps.onMeta?.(tabId, { title: e.text });
        // 권한을 거절하면 곧바로 tool_result(오류) 가 기록된다 → 대기 힌트를 내린다 (그 툴의 결과일 때만).
        if (e.type === "tool_result" && this.resultMatchesAttention(cur, e.toolUseId))
          this.setAttention(cur, null);
      }
    };
    if (s.provider === "claude") {
      const sessionId = s.sessionId!;
      s.mirror = new TranscriptWatcher({
        resolveFile: () => (fileHint && fs.existsSync(fileHint) ? fileHint : findClaudeTranscript(roots.claude, sessionId)),
        map: mapClaudeTranscriptLine,
        onEvents,
        skipExisting: !isNew,
        ...(startOffset !== null ? { startOffset } : {}),
      });
    } else {
      const cwd = s.cwd;
      s.mirror = new TranscriptWatcher({
        resolveFile: () =>
          s.sessionId
            ? findCodexRollout(roots.codex, { sessionId: s.sessionId })
            : findCodexRollout(roots.codex, { cwd, after: startedAt }),
        map: mapCodexRolloutLine,
        onEvents,
        skipExisting: !isNew,
        onFile: (file) => {
          // 새 Codex 세션이면 rollout 의 session_meta 에서 id 를 가져와 나중에 SDK 가 이어받게 한다.
          if (s.sessionId) return;
          const meta = readCodexRolloutMeta(file);
          if (meta?.sessionId) {
            s.sessionId = meta.sessionId;
            this.deps.onMeta?.(tabId, { sessionId: meta.sessionId });
            this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
          }
        },
      });
    }
    s.mirror.start();
  }

  /** 앱 기능(교차 리뷰 등)이 탭 기록에 남기는 알림 이벤트. */
  note(tabId: string, event: ChatEvent): void {
    this.record(this.ensure(tabId), event);
  }

  statuses(): Record<string, SessionStatus> {
    const out: Record<string, SessionStatus> = {};
    for (const [id, s] of this.sessions) out[id] = s.status;
    return out;
  }

  events(tabId: string): ChatEvent[] {
    const s = this.ensure(tabId);
    return this.loadEvents(s);
  }

  configure(tabId: string, patch: Partial<SessionConfig>): SessionSnapshot {
    const s = this.ensure(tabId);
    const meta: Parameters<NonNullable<SessionManagerDeps["onMeta"]>>[1] = {};
    if (patch.provider && patch.provider !== s.provider) {
      // provider 가 바뀌면 이전 provider 의 세션 id 는 의미가 없다. 살아 있던 Claude 프로세스도 내린다.
      closeProviderSessions(tabId);
      s.provider = patch.provider;
      s.sessionId = null;
      meta.provider = patch.provider;
      meta.sessionId = null;
    }
    if (patch.cwd !== undefined && patch.cwd !== s.cwd) {
      // 작업 경로가 바뀌면 provider 세션은 새로 시작한다 (기록은 그대로). 살아 있던 프로세스는 옛 cwd 것이라 내린다.
      closeProviderSessions(tabId);
      s.cwd = patch.cwd;
      s.sessionId = null;
      meta.sessionId = null;
      meta.cwd = patch.cwd;
    }
    if (patch.policy) {
      s.policy = patch.policy;
      meta.policy = patch.policy;
    }
    if ("model" in patch) {
      s.model = patch.model || undefined;
      meta.model = s.model;
    }
    if (Object.keys(meta).length > 0) this.deps.onMeta?.(tabId, meta);
    const snap = this.snapshot(tabId);
    // 설정을 바꾼 호출자 말고도(다른 창·스크립트·마운트 중인 뷰) 모두 새 스냅샷을 받게 한다 — 뷰가 마운트 직후 가져온 옛 값이 남지 않게.
    if (Object.keys(meta).length > 0) this.deps.onSnapshot?.(tabId, snap);
    return snap;
  }

  /**
   * 워크스페이스 기본 경로가 바뀌었을 때, 그 경로를 물려받는 탭(자기 경로가 없는 탭)의 세션 cwd 를 맞춘다.
   * configure 와 달리 탭에 경로를 박아 두지 않는다(계속 워크스페이스 것을 따라야 하므로). 아직 세션이 없는 탭은
   * 다음 ensure 때 새 경로로 만들어지니 손대지 않는다.
   */
  inheritCwd(tabId: string, cwd: string | null): void {
    const s = this.sessions.get(tabId);
    if (!s || s.cwd === cwd) return;
    closeProviderSessions(tabId);
    s.cwd = cwd;
    s.sessionId = null;
    this.deps.onMeta?.(tabId, { sessionId: null });
    this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
  }

  /** 전환 모달 미리보기: 지금까지의 이벤트로 요약과 통계를 만든다. */
  handoffPreview(tabId: string): Handoff {
    const s = this.ensure(tabId);
    return buildHandoff(this.events(tabId), {
      cwd: s.cwd,
      fromProvider: PROVIDER_LABEL[s.provider],
    });
  }

  /**
   * provider 전환. 실행 중이면 현재 턴을 중단한다(SDK 에 툴콜 단위 정지가 없다).
   * preserveContext 면 요약을 다음 프롬프트 앞에 붙인다. 화면의 대화는 그대로 남는다.
   */
  switchProvider(
    tabId: string,
    opts: { provider: Provider; model?: string; preserveContext: boolean },
  ): SessionSnapshot {
    const s = this.ensure(tabId);
    if (this.isBusy(tabId)) this.abort(tabId);
    const events = this.events(tabId);
    const handoff =
      opts.preserveContext && events.length > 0
        ? this.handoffPreview(tabId)
        : null;
    const from = s.provider;
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
    }
    s.limitAttempts = 0;
    closeProviderSessions(tabId); // 새 세션으로 시작하므로 살아 있던 프로세스는 내린다
    s.provider = opts.provider;
    s.model = opts.model || undefined;
    s.sessionId = null;
    s.handoffPrefix = handoff ? handoff.summary : null;
    this.deps.onMeta?.(tabId, {
      provider: s.provider,
      model: s.model,
      sessionId: null,
    });
    this.record(s, { type: "session_reset", ts: Date.now() });
    this.record(s, {
      type: "error",
      ts: Date.now(),
      fatal: false,
      message:
        from === opts.provider
          ? handoff
            ? `컨텍스트를 비우고 새 세션으로 시작합니다. 대화 요약(${handoff.stats.messages}개 메시지, ${handoff.stats.files}개 파일)을 다음 메시지에 함께 보냅니다.`
            : "새 세션으로 시작합니다."
          : handoff
            ? `${PROVIDER_LABEL[from]} → ${PROVIDER_LABEL[opts.provider]} 로 전환. 대화 요약(${handoff.stats.messages}개 메시지, ${handoff.stats.files}개 파일)을 다음 메시지에 함께 보냅니다.`
            : `${PROVIDER_LABEL[from]} → ${PROVIDER_LABEL[opts.provider]} 로 전환. 새 세션으로 시작합니다.`,
    });
    return this.snapshot(tabId);
  }

  /** 실행 중이거나 큐에 있으면 true. */
  isBusy(tabId: string): boolean {
    const s = this.sessions.get(tabId);
    return !!s && s.status !== "idle" && s.status !== "error";
  }

  private runningCount(): number {
    let n = 0;
    for (const s of this.sessions.values()) {
      if (this.exemptTabs.has(s.tabId)) continue;
      if (s.status === "running" || s.status === "waiting_permission") n += 1;
    }
    return n;
  }

  async send(
    tabId: string,
    text: string,
    images: StoredChatImage[],
    userEvent: ChatEvent,
  ): Promise<{ ok: true; queued: boolean; pending?: boolean } | { ok: false; error: string }> {
    const s = this.ensure(tabId);
    if (s.controller === "terminal")
      return {
        ok: false,
        error:
          "터미널이 이 세션을 제어 중입니다. CLI 를 종료하면 채팅으로 돌아옵니다.",
      };
    if (!s.cwd) return { ok: false, error: "작업 디렉토리가 없습니다." };
    if (this.isBusy(tabId) || s.limitWait) {
      // 턴 진행 중(또는 한도 재시도 대기 중): 큐에 넣고, 이 턴이 끝나면 자동으로 보낸다.
      if (s.promptQueue.length >= MAX_PROMPT_QUEUE)
        return { ok: false, error: `대기 중인 지시가 ${MAX_PROMPT_QUEUE}개를 넘었습니다.` };
      s.promptQueue.push({ id: randomUUID(), text, images, userEvent });
      this.persistQueue(s);
      this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
      return { ok: true, queued: false, pending: true };
    }
    // 사용자가 새 지시를 직접 보내는 것이므로 이전 한도 재시도 예산은 리셋.
    s.limitAttempts = 0;

    // 첫 사용자 메시지가 탭 제목이 된다.
    const hadUser = this.events(tabId).some((e) => e.type === "user_message");
    this.record(s, userEvent);
    if (
      !hadUser &&
      userEvent.type === "user_message" &&
      userEvent.text.trim()
    ) {
      this.deps.onMeta?.(tabId, { title: userEvent.text });
    }

    const prompt = s.handoffPrefix
      ? `${s.handoffPrefix}\n\n---\n\n${text}`
      : text;
    s.handoffPrefix = null;
    s.queued = { text, prompt, images };

    if (!this.canStart(tabId)) {
      this.queue.push(tabId);
      this.setStatus(s, "queued");
      return { ok: true, queued: true };
    }
    this.start(s);
    return { ok: true, queued: false };
  }

  private start(s: Session) {
    const turn = s.queued;
    if (!turn) return;
    s.queued = null;
    const abort = new AbortController();
    s.abort = abort;
    s.startedAt ??= Date.now();
    s.turnStartedAt = Date.now();
    // 턴 시작 시각을 렌더러가 바로 알게(진행 줄의 경과 시간 기준)
    this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
    this.setStatus(s, "running");

    // 한도 도달 감지: 오류 텍스트(turn_result/error) + rate_limit_event 의 거절 리셋 시각
    let limitText: string | null = null;
    let rejectedResetsAt: number | null = null;
    // 어댑터는 실패로 끝난 턴(turn_result.isError)도 정상 resolve 한다 — 여기서 기억해 두고 idle 대신 error 로 끝낸다.
    // 그래야 "앞 작업이 됐다" 는 전제로 큐의 다음 지시가 자동으로 나가지 않는다(사용자는 "지금 보내기" 로 이어갈 수 있다).
    let turnFailed = false;
    const emit = (e: ChatEvent) => {
      // Skill·Agent 카드가 열리면 companion Codex 의 rollout 을 찾기 시작하고, 그 카드가 끝나면 멈춘다
      if (s.provider === "claude" && e.type === "tool_use" && !e.partial && !e.preview && AGENT_TOOLS.has(e.name) && !s.companion) this.startCompanion(s, e.toolUseId);
      if (e.type === "tool_result" && s.companion?.parentToolUseId === e.toolUseId) this.stopCompanion(s);
      if (e.type === "turn_result" && e.isError) turnFailed = true;
      if (e.type === "turn_result" && e.isError && isUsageLimitText(e.errorText)) limitText = e.errorText ?? "usage limit";
      if (e.type === "error" && isUsageLimitText(e.message)) limitText = e.message;
      if (e.type === "status") s.status = e.status;
      if (e.type === "session" || (e.type === "turn_result" && e.sessionId)) {
        const next = e.sessionId ?? s.sessionId;
        if (next !== s.sessionId) {
          s.sessionId = next;
          this.deps.onMeta?.(s.tabId, { sessionId: next });
        }
      }
      this.record(s, e);
    };

    void (async () => {
      try {
        if (s.provider === "codex") {
          const runtime = await this.deps.codexRuntime();
          await runCodexTurn(runtime, {
            sessionKey: s.tabId,
            cwd: s.cwd!,
            prompt: turn.prompt,
            images: turn.images,
            sessionId: s.sessionId,
            policy: s.policy,
            model: s.model,
            abort,
            onEvent: emit,
            requestPermission: (req) => this.waitPermission(s, req, abort.signal),
            log: (line) => this.deps.log?.(s.tabId, line),
          });
        } else {
          const runtime = await this.deps.claudeRuntime();
          await runClaudeTurn(runtime, {
            sessionKey: s.tabId,
            cwd: s.cwd!,
            prompt: turn.prompt,
            images: turn.images,
            sessionId: s.sessionId,
            policy: s.policy,
            model: s.model,
            abort,
            onEvent: emit,
            requestPermission: (req) =>
              this.waitPermission(s, req, abort.signal),
            log: (line) => this.deps.log?.(s.tabId, line),
            onCommands: (patch) => this.deps.onSlashCommands?.(s.cwd!, patch),
            onRateLimit: (limit) => {
              if (limit.rejectedResetsAt) rejectedResetsAt = limit.rejectedResetsAt;
              this.deps.onRateLimit?.("claude", limit);
            },
          });
        }
        // 한도 오류는 finally 의 재시도 예약이 맡는다(그 경로는 idle 을 전제로 한다).
        this.setStatus(s, turnFailed && !limitText && !abort.signal.aborted ? "error" : "idle");
      } catch (e) {
        if (!abort.signal.aborted && isUsageLimitText(describeError(e))) limitText = describeError(e);
        if (abort.signal.aborted) {
          this.record(s, {
            type: "error",
            ts: Date.now(),
            message: "중단됨",
            fatal: false,
          });
          this.setStatus(s, "idle");
        } else {
          this.record(s, {
            type: "error",
            ts: Date.now(),
            message: describeError(e),
          });
          this.setStatus(s, "error");
        }
      } finally {
        s.abort = null;
        s.turnStartedAt = null;
        // 탭이 닫히며 release 된 뒤에 늦게 끝난 턴이면 세션이 이미 지워져 있다 —
        // snapshot() 은 ensure() 로 되살리므로, 아직 같은 세션일 때만 알린다.
        if (this.sessions.get(s.tabId) === s) this.deps.onSnapshot?.(s.tabId, this.snapshot(s.tabId));
        this.stopCompanion(s);
        this.rejectAllPending(s);
        if (limitText && !abort.signal.aborted) {
          // 재시도를 예약한다. 큐는 재시도가 성공할 때까지 멈춰 둔다(연쇄로 같은 한도에 걸리며 유실되는 것을 막는다).
          if (s.limitAttempts > 0) s.limitWait = { until: null, attempts: s.limitAttempts, message: "", turn, timer: null };
          this.scheduleLimitRetry(s, turn, limitText, rejectedResetsAt);
        } else if (!abort.signal.aborted) {
          s.limitAttempts = 0;
        }
        this.drain();
        // 중단된 턴(사용자 중단·탭 닫기·앱 종료) 뒤에는 큐를 자동으로 보내지 않는다 — 닫는 중에 새 턴이 시작되면 안 된다.
        if (!s.limitWait && !abort.signal.aborted) this.drainPending(s);
      }
    })();
  }

  private startCompanion(s: Session, parentToolUseId: string) {
    const roots = this.deps.transcriptRoots;
    if (!roots || !s.cwd) return;
    const tabId = s.tabId;
    s.companion = new CompanionMirror({
      codexRoot: roots.codex,
      cwd: s.cwd,
      since: Date.now(),
      parentToolUseId,
      // 앱 자신의 Codex 탭 세션은 companion 이 아니다
      excludeSessionIds: () => new Set([...this.sessions.values()].filter((x) => x.provider === "codex" && x.sessionId).map((x) => x.sessionId!)),
      onEvents: (events) => {
        const cur = this.sessions.get(tabId);
        if (!cur || cur.companion?.parentToolUseId !== parentToolUseId) return;
        for (const e of events) this.record(cur, e);
      },
    });
    s.companion.start();
    this.deps.log?.(tabId, `[companion] ${parentToolUseId} 카드 동안 Codex rollout 감시 시작 (cwd ${s.cwd})`);
  }

  private stopCompanion(s: Session) {
    if (!s.companion) return;
    const file = s.companion.file();
    s.companion.stop();
    s.companion = null;
    if (file) this.deps.log?.(s.tabId, `[companion] 감시 종료 (${file})`);
  }

  /** 상한과 무관하게 시작해도 되는지: 예외 탭(코디네이터)이거나 자리가 있으면. */
  private canStart(tabId: string): boolean {
    return this.exemptTabs.has(tabId) || this.runningCount() < this.maxConcurrent;
  }

  private drain() {
    // 예외 탭은 큐 어디에 있든 먼저 꺼내고, 나머지는 자리가 나는 만큼 순서대로
    for (const tabId of [...this.queue]) {
      if (!this.exemptTabs.has(tabId)) continue;
      this.queue.splice(this.queue.indexOf(tabId), 1);
      const s = this.sessions.get(tabId);
      if (s && s.status === "queued" && s.queued) this.start(s);
    }
    while (this.queue.length > 0 && this.runningCount() < this.maxConcurrent) {
      const tabId = this.queue.shift()!;
      const s = this.sessions.get(tabId);
      if (!s || s.status !== "queued" || !s.queued) continue;
      this.start(s);
    }
  }

  /**
   * 사용자의 중단은 "멈춰" 라는 뜻: 실행 여부와 무관하게 한도 재시도 예약과 써 둔 다음 지시를 버린다.
   * keepQueue 는 앱 종료·탭 닫기 같은 정리 경로용 — 대기 지시를 디스크에 남겨 다음 실행에서 복원한다.
   */
  abort(tabId: string, opts: { keepQueue?: boolean } = {}): boolean {
    const s = this.sessions.get(tabId);
    if (!s) return false;
    let did = false;
    if (s.limitWait) {
      this.clearLimitTimer(s);
      s.limitWait = null;
      s.limitAttempts = 0;
      did = true;
    }
    if (s.promptQueue.length > 0 && !opts.keepQueue) {
      s.promptQueue = [];
      this.persistQueue(s);
      did = true;
    }
    if (did) this.deps.onSnapshot?.(tabId, this.snapshot(tabId));
    if (s.status === "queued") {
      const i = this.queue.indexOf(tabId);
      if (i !== -1) this.queue.splice(i, 1);
      s.queued = null;
      this.record(s, {
        type: "error",
        ts: Date.now(),
        message: "대기열에서 취소됨",
        fatal: false,
      });
      this.setStatus(s, "idle");
      return true;
    }
    if (!s.abort) return did;
    this.rejectAllPending(s);
    s.abort.abort();
    return true;
  }

  answerPermission(
    tabId: string,
    requestId: string,
    answer: PermissionAnswer,
  ): boolean {
    const s = this.sessions.get(tabId);
    const resolve = s?.pending.get(requestId);
    if (!s || !resolve) return false;
    s.pending.delete(requestId);
    s.pendingReqs.delete(requestId);
    resolve(answer);
    return true;
  }

  /** 이 provider 세션 id 를 쓰는 탭. 백그라운드 작업 기록처럼 tabId 를 모르는 쪽이 탭을 찾을 때. */
  tabForSessionId(sessionId: string): string | null {
    if (!sessionId) return null;
    for (const [tabId, s] of this.sessions) if (s.sessionId === sessionId) return tabId;
    return null;
  }

  /** 답을 기다리는 권한 요청들. */
  pendingPermissions(tabId: string): PermissionRequestEvent[] {
    return [...(this.sessions.get(tabId)?.pendingReqs.values() ?? [])];
  }

  /** 대화를 비운다. 실행 중이면 중단. provider 세션도 새로 시작한다. */
  clear(tabId: string): SessionSnapshot {
    const s = this.ensure(tabId);
    this.externalCliExited(tabId);
    if (s.controller === "terminal") this.detachTerminal(tabId);
    if (this.isBusy(tabId)) this.abort(tabId);
    closeProviderSessions(tabId);
    s.events = [];
    s.sessionId = null;
    s.handoffPrefix = null;
    s.startedAt = null;
    s.promptQueue = [];
    this.persistQueue(s);
    this.clearLimitTimer(s);
    s.limitWait = null;
    s.limitAttempts = 0;
    this.deps.store?.resetThread(tabId);
    this.deps.onMeta?.(tabId, { sessionId: null, title: "" });
    return this.snapshot(tabId);
  }

  /** 탭을 닫을 때: 중단하고 메모리에서 내린다. 디스크의 스레드는 남는다(다시 열기). */
  /** 탭 닫기·삭제: 턴을 멈추고 세션을 내린다. 대기 지시는 디스크에 남긴다(삭제면 스레드와 함께 지워진다). */
  release(tabId: string): void {
    this.externalCliExited(tabId);
    this.abort(tabId, { keepQueue: true });
    closeProviderSessions(tabId);
    const s = this.sessions.get(tabId);
    if (s) {
      s.mirror?.stop();
      this.stopCompanion(s);
      this.stopHookWatcher(s);
      this.clearLimitTimer(s);
      s.limitWait = null;
    }
    this.sessions.delete(tabId);
  }

  abortAll(opts: { keepQueue?: boolean } = {}): void {
    for (const tabId of this.sessions.keys()) this.abort(tabId, opts);
  }

  /** 앱 종료: 턴 중단 + 미러·훅 워처 정리(훅 로그 삭제). */
  shutdown(): void {
    this.abortAll({ keepQueue: true });
    closeAllClaudeSessions();
    closeAllCodexSessions();
    for (const s of this.sessions.values()) {
      s.mirror?.stop();
      s.mirror = null;
      this.stopCompanion(s);
      this.stopHookWatcher(s);
      this.clearLimitTimer(s);
      s.limitWait = null;
    }
  }

  /** 기록을 처음 읽을 때: 지난 실행에서 "진행 중" 으로 남은 카드(verify·fanout·review)는 이 프로세스에 없으므로 닫아 준다. */
  private loadEvents(s: Session): ChatEvent[] {
    if (s.events) return s.events;
    const events = this.deps.store?.readEvents(s.tabId) ?? [];
    for (const e of staleRunEvents(events)) {
      events.push(e);
      this.deps.store?.appendEvent(s.tabId, e);
    }
    s.events = events;
    return events;
  }

  private record(s: Session, e: ChatEvent) {
    // 생각 조각은 화면에만 흘리고 기록·메모리엔 남기지 않는다(양이 크고 다시 볼 일이 없다).
    if (e.type === "thinking_delta" || e.type === "subagent_activity" || (e.type === "tool_use" && e.preview) || (e.type === "verify" && e.partial)) {
      this.deps.emit(s.tabId, e);
      return;
    }
    this.loadEvents(s).push(e);
    this.deps.store?.appendEvent(s.tabId, e);
    this.deps.emit(s.tabId, e);
  }

  private waitPermission(
    s: Session,
    req: PermissionRequestEvent,
    signal: AbortSignal,
  ): Promise<PermissionAnswer> {
    return new Promise((resolve) => {
      const done = (answer: PermissionAnswer) => {
        signal.removeEventListener("abort", onAbort);
        resolve(answer);
      };
      const onAbort = () => {
        s.pending.delete(req.requestId);
        s.pendingReqs.delete(req.requestId);
        done({ behavior: "deny" });
      };
      if (signal.aborted) return onAbort();
      signal.addEventListener("abort", onAbort, { once: true });
      s.pending.set(req.requestId, done);
      s.pendingReqs.set(req.requestId, req);
    });
  }

  private rejectAllPending(s: Session) {
    for (const [id, resolve] of s.pending) {
      s.pending.delete(id);
      resolve({ behavior: "deny" });
    }
  }

  private setStatus(s: Session, status: SessionStatus) {
    s.status = status;
    this.record(s, { type: "status", ts: Date.now(), status });
    this.deps.onStatus?.(s.tabId, status);
    // 진행 중 수·승인 대기 수·대기 순번이 바뀌었을 수 있다 — 기다리는 탭들에 알린다.
    if (this.queue.length > 0) this.broadcastQueued();
  }
}

/** 권한 힌트용 한 줄 요약. 렌더러의 툴카드 요약과 같은 규칙을 최소로 따른다. */
export function summarizeToolInput(
  tool: string,
  input: Record<string, unknown>,
): string {
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const firstLine = (v: string) => v.split("\n")[0].trim();
  if (tool === "Bash") return firstLine(str(input.description) || str(input.command));
  if (tool === "AskUserQuestion") {
    const qs = Array.isArray(input.questions) ? (input.questions as { question?: unknown }[]) : [];
    return qs.map((q) => str(q?.question)).filter(Boolean).join(" · ").slice(0, 160);
  }
  const p = str(input.file_path) || str(input.notebook_path) || str(input.path);
  if (p) return p;
  if (str(input.url)) return str(input.url);
  if (str(input.pattern)) return str(input.pattern);
  const keys = Object.keys(input);
  return keys.length ? firstLine(JSON.stringify(input)).slice(0, 120) : "";
}

function describeError(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  if (/ENOENT/.test(msg)) return `CLI 실행 파일을 찾지 못했습니다: ${msg}`;
  return msg;
}
