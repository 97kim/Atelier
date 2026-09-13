// Claude Agent SDK 실행 어댑터. 탭(세션 키)마다 CLI 프로세스를 하나 살려 두고(streaming input), 턴마다 사용자 메시지를 흘려보낸다.
// 예전에는 턴마다 query() 를 새로 열어 프로세스 기동·MCP 연결·세션 복원 비용(3~5초)을 매번 냈다.
// SDK 메시지 → ChatEvent 변환은 claude-events.ts 가, 권한 응답 대기는 SessionManager 가 맡는다.

import type {
  ChatEvent,
  PermissionAnswer,
  PermissionPolicy,
  PermissionRequestEvent,
} from "@shared/chat-events";
import type { SlashCommandDto } from "@shared/slash-commands";
import type { ProviderRateLimitDto } from "@shared/ipc";
import { buildClaudeUserMessage, type StoredChatImage } from "./chat-attachments";
import { ClaudeEventMapper, parseClaudeRateLimit } from "./claude-events";
import { importClaudeSdk } from "./esm";

type SdkOptions = import("@anthropic-ai/claude-agent-sdk").Options;
type SDKUserMessage = import("@anthropic-ai/claude-agent-sdk").SDKUserMessage;
type SDKMessage = import("@anthropic-ai/claude-agent-sdk").SDKMessage;
type PermissionMode = import("@anthropic-ai/claude-agent-sdk").PermissionMode;
type PermissionResult = import("@anthropic-ai/claude-agent-sdk").PermissionResult;
type PermissionUpdate = import("@anthropic-ai/claude-agent-sdk").PermissionUpdate;
type Query = import("@anthropic-ai/claude-agent-sdk").Query;

export interface ClaudeRuntime {
  pathToClaudeCodeExecutable: string;
  env: Record<string, string>;
}

export interface ClaudeTurnRequest {
  /** 살려 둘 프로세스의 키(탭 id). 같은 키의 다음 턴은 같은 프로세스로 간다. */
  sessionKey: string;
  cwd: string;
  prompt: string;
  images: StoredChatImage[];
  sessionId: string | null;
  policy: PermissionPolicy;
  model?: string;
  abort: AbortController;
  onEvent(event: ChatEvent): void;
  /** renderer 가 답할 때까지 resolve 되지 않는다. abort 되면 deny 로 resolve. */
  requestPermission(req: PermissionRequestEvent): Promise<PermissionAnswer>;
  log?(line: string): void;
  /** 턴 도중 알게 된 슬래시 커맨드 정보 (init 의 터미널 전용 목록, commands_changed 의 전체 목록). */
  onCommands?(patch: { commands?: SlashCommandDto[]; terminal?: string[] }): void;
  /** 구독 한도(5시간/주간 창) 관측값. 턴 중 rate_limit_event 가 올 때마다. */
  onRateLimit?(limit: ProviderRateLimitDto): void;
}

const POLICY_TO_MODE: Record<PermissionPolicy, PermissionMode> = {
  ask: "default",
  auto_edit: "acceptEdits",
  full: "bypassPermissions",
};

/**
 * 사용자의 답을 SDK canUseTool 결과로 바꾼다.
 * AskUserQuestion 은 권한이 아니라 질문이라 bypassPermissions 에서도 여기로 온다 — 허용이면 답을 `updatedInput.answers` 에 실어 돌려준다
 * (SDK 계약: 질문 문장 → 답 문자열). 답 없이 허용하면 CLI 가 빈 답으로 처리하므로 거부와 같게 다룬다.
 */
export function permissionResultFor(
  toolName: string,
  toolInput: Record<string, unknown>,
  answer: PermissionAnswer,
  suggestions?: PermissionUpdate[],
): PermissionResult {
  if (toolName === "AskUserQuestion") {
    if (answer.behavior === "allow" && answer.answers && Object.keys(answer.answers).length > 0) {
      return { behavior: "allow", updatedInput: { ...toolInput, answers: answer.answers } };
    }
    return { behavior: "deny", message: "사용자가 질문에 답하지 않았습니다. 필요하면 합리적인 기본값으로 진행하세요.", interrupt: false };
  }
  if (answer.behavior === "allow") {
    return { behavior: "allow", updatedInput: toolInput, updatedPermissions: answer.always ? suggestions : undefined };
  }
  return { behavior: "deny", message: "사용자가 이 작업을 거부했습니다.", interrupt: false };
}

/** 턴이 없는 채로 이만큼 지나면 프로세스를 내린다(메모리·MCP 연결 점유). 다음 턴에 다시 뜬다. 설정에서 바꿀 수 있다. */
export const CLAUDE_SESSION_IDLE_MS = 10 * 60 * 1000;
let sessionIdleMs = CLAUDE_SESSION_IDLE_MS;
/** 유휴 시간을 바꾼다. 지금 놀고 있는 프로세스의 타이머도 새 값으로 다시 건다. */
export function setClaudeSessionIdleMs(ms: number): void {
  sessionIdleMs = ms;
  for (const s of live.values()) if (!s.turn && s.idleTimer) armIdle(s);
}
/** interrupt 뒤 result 가 이만큼 안 오면 프로세스를 끊는다. */
const INTERRUPT_GRACE_MS = 8000;

/** streaming input 용 푸시 큐. 닫으면 iterable 이 끝나고 CLI 는 정리 후 종료한다. */
export class InputQueue {
  private readonly items: SDKUserMessage[] = [];
  private waiter: (() => void) | null = null;
  private closed = false;
  push(m: SDKUserMessage) {
    if (this.closed) return;
    this.items.push(m);
    this.waiter?.();
  }
  close() {
    this.closed = true;
    this.waiter?.();
  }
  async *iterate(): AsyncGenerator<SDKUserMessage, void, void> {
    for (;;) {
      if (this.items.length > 0) {
        yield this.items.shift()!;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => (this.waiter = r));
      this.waiter = null;
    }
  }
}

interface TurnCtx {
  req: ClaudeTurnRequest;
  mapper: ClaudeEventMapper;
  resolve(): void;
  reject(e: unknown): void;
  permissionSeq: number;
}

interface LiveSession {
  key: string;
  cwd: string;
  /** CLI 가 알려 준 세션 id(init/result). 새 탭이면 첫 init 때 채워진다. */
  sessionId: string | null;
  mode: PermissionMode;
  model: string | undefined;
  q: Query;
  input: InputQueue;
  turn: TurnCtx | null;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  log?(line: string): void;
}

const live = new Map<string, LiveSession>();
/** 여는 중인 세션 — 예열과 첫 턴이 거의 동시에 오면 프로세스를 하나만 띄운다. */
const opening = new Map<string, Promise<LiveSession>>();

/** 테스트·진단용: 살아 있는 세션 키. */
export function liveClaudeSessions(): string[] {
  return [...live.keys()];
}

/** 프로세스를 내린다(탭 해제·대화 비우기·provider 전환·cwd 변경·앱 종료). 진행 중인 턴이 있으면 중단으로 끝난다. */
export function closeClaudeSession(key: string): void {
  const s = live.get(key);
  if (!s) return;
  live.delete(key);
  s.dead = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.input.close();
  try {
    s.q.close();
  } catch {
    /* 이미 끝남 */
  }
  s.turn?.reject(new Error("세션이 종료되었습니다."));
  s.turn = null;
}

export function closeAllClaudeSessions(): void {
  for (const key of [...live.keys()]) closeClaudeSession(key);
}

function armIdle(s: LiveSession) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (live.get(s.key) === s && !s.turn) {
      s.log?.(`[claude ${s.key}] idle ${sessionIdleMs}ms — 프로세스 종료`);
      closeClaudeSession(s.key);
    }
  }, sessionIdleMs);
  s.idleTimer.unref?.();
}

function openSession(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<LiveSession> {
  const inflight = opening.get(req.sessionKey);
  if (inflight) return inflight;
  const p = openSessionNow(runtime, req).finally(() => {
    if (opening.get(req.sessionKey) === p) opening.delete(req.sessionKey);
  });
  opening.set(req.sessionKey, p);
  return p;
}

async function openSessionNow(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<LiveSession> {
  const { query } = await importClaudeSdk();
  const input = new InputQueue();
  const s: LiveSession = {
    key: req.sessionKey,
    cwd: req.cwd,
    sessionId: req.sessionId,
    mode: POLICY_TO_MODE[req.policy],
    model: req.model,
    q: null as unknown as Query,
    input,
    turn: null,
    dead: false,
    idleTimer: null,
    log: req.log,
  };
  const options: SdkOptions = {
    cwd: req.cwd,
    env: runtime.env,
    pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
    model: req.model,
    resume: req.sessionId ?? undefined,
    includePartialMessages: true,
    // SDK 는 systemPrompt 를 안 주면 빈 시스템 프롬프트로 띄운다 — 터미널 Claude Code 와 같은 기본 프롬프트(작업 전 한 줄 설명·간결한 답·도구 사용 규칙)를 쓴다
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      // 앱 화면은 툴카드가 접혀 있어 터미널보다 맥락이 덜 보인다 — 도구 사이사이에 짧은 설명을 두게 한다
      append: [
        "이 대화는 Atelier 앱 채팅 화면에 표시된다. 도구 호출은 접힌 카드로만 보이므로, 사용자가 흐름을 따라올 수 있게 다음을 지켜라.",
        "- 도구를 부르기 전에 무엇을 왜 하려는지 한 문장으로 말하라.",
        "- IMPORTANT: 도구 결과를 받은 뒤 다음 도구를 부르기 전에는 예외 없이 먼저 한두 문장을 써라 — 방금 무엇을 알아냈고(원인을 찾았으면 원인), 그래서 다음에 무엇을 할지. 텍스트 없이 도구 호출만 연달아 하는 것은 금지다.",
        "- 이 설명은 짧게. 같은 말을 형식적으로 반복하지 말고, 최종 답에서 과정을 다시 길게 요약하지 마라.",
      ].join("\n"),
    },
    permissionMode: s.mode,
    allowDangerouslySkipPermissions: req.policy === "full" ? true : undefined,
    stderr: (line) => (s.turn?.req.log ?? s.log)?.(line),
    // 권한 요청은 "지금 진행 중인 턴" 의 콜백으로 — 프로세스는 턴을 넘어 살기 때문에 options 에 고정할 수 없다.
    canUseTool: async (toolName, toolInput, ctx) => {
      const t = s.turn;
      if (!t) return { behavior: "deny", message: "진행 중인 턴이 없습니다.", interrupt: false };
      const requestId = `${ctx.toolUseID}#${++t.permissionSeq}`;
      const event: PermissionRequestEvent = {
        type: "permission_request",
        ts: Date.now(),
        requestId,
        toolUseId: ctx.toolUseID,
        tool: toolName,
        input: toolInput,
        title: ctx.title,
        description: ctx.description,
        canAlwaysAllow: Boolean(ctx.suggestions && ctx.suggestions.length > 0),
      };
      t.req.onEvent(event);
      t.req.onEvent({ type: "status", ts: Date.now(), status: "waiting_permission" });
      const answer = await t.req.requestPermission(event);
      t.req.onEvent({ type: "permission_resolved", ts: Date.now(), requestId, behavior: answer.behavior });
      t.req.onEvent({ type: "status", ts: Date.now(), status: "running" });
      return permissionResultFor(toolName, toolInput, answer, ctx.suggestions);
    },
  };
  s.q = query({ prompt: input.iterate(), options });
  live.set(req.sessionKey, s);
  void pump(s);
  return s;
}

/** 프로세스가 사는 동안 메시지를 계속 읽어 진행 중인 턴에 전달한다. result 가 턴의 끝. */
async function pump(s: LiveSession) {
  try {
    for await (const message of s.q) handleMessage(s, message);
  } catch (e) {
    s.turn?.reject(e);
    s.turn = null;
  } finally {
    // 프로세스가 끝났다(정상 종료·크래시·close). 진행 중이던 턴은 실패로.
    if (live.get(s.key) === s) live.delete(s.key);
    s.dead = true;
    if (s.idleTimer) clearTimeout(s.idleTimer);
    s.turn?.reject(new Error("Claude 프로세스가 끝났습니다."));
    s.turn = null;
  }
}

function handleMessage(s: LiveSession, message: SDKMessage) {
  const t = s.turn;
  if (message.type === "system") {
    if (message.subtype === "init") {
      s.sessionId = message.session_id;
      if (message.terminal_slash_commands) t?.req.onCommands?.({ terminal: message.terminal_slash_commands });
    } else if (message.subtype === "commands_changed") {
      t?.req.onCommands?.({
        commands: message.commands.map((c) => ({
          name: c.name,
          description: c.description ?? "",
          argumentHint: c.argumentHint ?? "",
          aliases: c.aliases && c.aliases.length > 0 ? c.aliases : undefined,
        })),
      });
    }
  }
  if (message.type === "rate_limit_event") {
    const limit = parseClaudeRateLimit(message.rate_limit_info, Date.now());
    if (limit) t?.req.onRateLimit?.(limit);
  }
  if (!t) {
    // 턴 밖에서 온 메시지(백그라운드 태스크 알림 등)는 기록할 턴이 없다 — 로그만.
    if (message.type !== "system") s.log?.(`[claude ${s.key}] 턴 밖 메시지 ${message.type}`);
    return;
  }
  for (const e of t.mapper.map(message, Date.now())) t.req.onEvent(e);
  if (message.type === "result") {
    if (message.session_id) s.sessionId = message.session_id;
    s.turn = null;
    t.resolve();
  }
}

/** 살아 있는 세션을 이 턴에 맞추거나(정책·모델), 맞출 수 없으면(cwd·세션 id 가 다름) 내리고 새로 연다. */
async function sessionFor(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<LiveSession> {
  const inflight = opening.get(req.sessionKey);
  if (inflight) await inflight.catch(() => {}); // 예열이 여는 중이면 그 프로세스를 쓴다
  const cur = live.get(req.sessionKey);
  if (cur && !cur.dead) {
    const sameSession = req.sessionId === null || cur.sessionId === null || req.sessionId === cur.sessionId;
    const mode = POLICY_TO_MODE[req.policy];
    // bypassPermissions 는 프로세스 시작 플래그(allowDangerouslySkipPermissions)와 묶여 있어 setPermissionMode 로 오가면 안 된다 — 새로 띄운다.
    const bypassFlip = (mode === "bypassPermissions") !== (cur.mode === "bypassPermissions");
    if (cur.cwd === req.cwd && sameSession && !cur.turn && !bypassFlip) {
      if (mode !== cur.mode) {
        await cur.q.setPermissionMode(mode);
        cur.mode = mode;
      }
      if ((req.model ?? undefined) !== cur.model) {
        await cur.q.setModel(req.model);
        cur.model = req.model;
      }
      return cur;
    }
    closeClaudeSession(req.sessionKey);
  }
  return openSession(runtime, req);
}

export type ClaudeWarmRequest = Pick<ClaudeTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log">;

/**
 * 예열: 턴 없이 프로세스만 미리 띄운다(기동·MCP 연결·세션 복원을 사용자가 첫 메시지를 보내기 전에 끝내 둔다).
 * 이미 맞는 세션이 살아 있으면 아무것도 안 한다. 유휴 타이머는 그대로 걸린다.
 */
export async function warmClaudeSession(runtime: ClaudeRuntime, req: ClaudeWarmRequest): Promise<"reused" | "opened"> {
  if (opening.has(req.sessionKey)) return "reused";
  const cur = live.get(req.sessionKey);
  const mode = POLICY_TO_MODE[req.policy];
  if (cur && !cur.dead) {
    const sameSession = req.sessionId === null || cur.sessionId === null || req.sessionId === cur.sessionId;
    const bypassFlip = (mode === "bypassPermissions") !== (cur.mode === "bypassPermissions");
    if (cur.cwd === req.cwd && sameSession && !bypassFlip) return "reused";
    if (cur.turn) return "reused"; // 턴 중인 프로세스는 건드리지 않는다
    closeClaudeSession(req.sessionKey);
  }
  const s = await openSession(runtime, {
    ...req,
    prompt: "",
    images: [],
    abort: new AbortController(),
    onEvent: () => {},
    requestPermission: async () => ({ behavior: "deny" }),
  });
  armIdle(s);
  return "opened";
}

export async function runClaudeTurn(runtime: ClaudeRuntime, req: ClaudeTurnRequest): Promise<void> {
  if (req.abort.signal.aborted) throw new Error("중단됨");
  const s = await sessionFor(runtime, req);
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  const done = new Promise<void>((resolve, reject) => {
    s.turn = { req, mapper: new ClaudeEventMapper(), resolve, reject, permissionSeq: 0 };
  });
  // 중단: 프로세스는 살려 두고 이 턴만 끊는다. result 가 안 오면 프로세스를 내린다.
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    void s.q.interrupt().catch(() => {});
    graceTimer = setTimeout(() => {
      if (s.turn?.req === req) closeClaudeSession(s.key);
    }, INTERRUPT_GRACE_MS);
  };
  req.abort.signal.addEventListener("abort", onAbort, { once: true });
  try {
    s.input.push(buildClaudeUserMessage(req.images, req.prompt));
    await done;
  } finally {
    req.abort.signal.removeEventListener("abort", onAbort);
    if (graceTimer) clearTimeout(graceTimer);
    if (live.get(s.key) === s && !s.dead) armIdle(s);
  }
}
