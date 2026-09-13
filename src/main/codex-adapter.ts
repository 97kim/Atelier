// Codex 실행 어댑터. 기본 경로는 `codex app-server`(codex-app-server.ts): 탭마다 프로세스 하나를 살려 두고 스레드를 이어 가며
// 턴마다 `turn/start` 만 보낸다. 승인(명령 실행·파일 변경)은 서버 요청으로 받아 앱의 권한 카드로 잇는다.
// app-server 를 못 띄우는 옛 CLI 는 SDK exec 경로(턴마다 `codex exec`)로 폴백한다 — 그 경로엔 승인 콜백이 없어 정책을 샌드박스로만 매핑한다.

import type { ChatEvent, PermissionAnswer, PermissionPolicy, PermissionRequestEvent } from "@shared/chat-events";
import { buildCodexInput, type StoredChatImage } from "./chat-attachments";
import { mapCodexEvent } from "./codex-events";
import { CodexAppServer, classifyResumeFailure, mapAppServerNotification, normalizeFileChanges, resumeConflictMessage, type AppServerTurnContext, type FileChangeDto } from "./codex-app-server";
import { importCodexSdk } from "./esm";

type ThreadOptions = import("@openai/codex-sdk").ThreadOptions;

export interface CodexRuntime {
  codexPath: string;
  env: Record<string, string>;
}

export interface CodexTurnRequest {
  /** 살려 둘 프로세스의 키(탭 id). */
  sessionKey: string;
  cwd: string;
  prompt: string;
  images: StoredChatImage[];
  sessionId: string | null;
  policy: PermissionPolicy;
  model?: string;
  abort: AbortController;
  onEvent(event: ChatEvent): void;
  /** app-server 경로에서 승인 요청이 오면 renderer 가 답할 때까지 기다린다. */
  requestPermission?(req: PermissionRequestEvent): Promise<PermissionAnswer>;
  log?(line: string): void;
}

/** app-server 의 정책 매핑: ask 는 신뢰되지 않은 명령·쓰기마다 묻고, auto_edit 은 작업 디렉토리 밖·네트워크만 묻고, full 은 묻지 않는다. */
const POLICY_TO_APPSERVER: Record<PermissionPolicy, { approvalPolicy: string; sandbox: string; sandboxPolicy: Record<string, unknown> }> = {
  ask: { approvalPolicy: "untrusted", sandbox: "read-only", sandboxPolicy: { type: "readOnly" } },
  auto_edit: { approvalPolicy: "on-request", sandbox: "workspace-write", sandboxPolicy: { type: "workspaceWrite", networkAccess: true } },
  full: { approvalPolicy: "never", sandbox: "danger-full-access", sandboxPolicy: { type: "dangerFullAccess" } },
};

/** exec 폴백의 정책 매핑(승인을 물을 수 없다). */
const POLICY_TO_THREAD: Record<PermissionPolicy, Pick<ThreadOptions, "sandboxMode" | "networkAccessEnabled">> = {
  ask: { sandboxMode: "read-only" },
  auto_edit: { sandboxMode: "workspace-write", networkAccessEnabled: true },
  full: { sandboxMode: "danger-full-access", networkAccessEnabled: true },
};

export const CODEX_SESSION_IDLE_MS = 10 * 60 * 1000;
let sessionIdleMs = CODEX_SESSION_IDLE_MS;
/** 유휴 시간을 바꾼다. 지금 놀고 있는 프로세스의 타이머도 새 값으로 다시 건다. */
export function setCodexSessionIdleMs(ms: number): void {
  sessionIdleMs = ms;
  for (const s of live.values()) if (!s.turn && s.idleTimer) armIdle(s);
}
const INTERRUPT_GRACE_MS = 8000;

interface TurnCtx {
  req: CodexTurnRequest;
  turnId: string | null;
  ctx: AppServerTurnContext;
  resolve(): void;
  reject(e: unknown): void;
  permissionSeq: number;
}

interface LiveCodex {
  key: string;
  cwd: string;
  server: CodexAppServer;
  /** 스레드 start/resume 까지 끝나면 resolve. 예열 중 들어온 첫 턴이 이걸 기다린다. */
  ready: Promise<void>;
  threadId: string | null;
  turn: TurnCtx | null;
  /** 진행 중인 fileChange 아이템의 변경 내용(itemId → changes). 승인 요청엔 diff 가 없어 item/started 에서 받아 둔 것을 카드에 보여 준다. */
  fileChanges: Map<string, FileChangeDto[]>;
  dead: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  log?(line: string): void;
}

const live = new Map<string, LiveCodex>();
const opening = new Map<string, Promise<LiveCodex>>();
/** app-server 를 한 번 못 띄웠으면(옛 CLI) 이 실행 동안은 exec 로만 간다. */
let appServerUnavailable: string | null = null;

export function liveCodexSessions(): string[] {
  return [...live.keys()];
}

export function closeCodexSession(key: string): void {
  const s = live.get(key);
  if (!s) return;
  live.delete(key);
  s.dead = true;
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.server.close();
  s.turn?.reject(new Error("세션이 종료되었습니다."));
  s.turn = null;
}

export function closeAllCodexSessions(): void {
  for (const key of [...live.keys()]) closeCodexSession(key);
}

function armIdle(s: LiveCodex) {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = setTimeout(() => {
    if (live.get(s.key) === s && !s.turn) {
      s.log?.(`[codex ${s.key}] idle ${sessionIdleMs}ms — 프로세스 종료`);
      closeCodexSession(s.key);
    }
  }, sessionIdleMs);
  s.idleTimer.unref?.();
}

function openSession(runtime: CodexRuntime, key: string, cwd: string, log?: (line: string) => void): Promise<LiveCodex> {
  const inflight = opening.get(key);
  if (inflight) return inflight;
  const p = openSessionNow(runtime, key, cwd, log).finally(() => {
    if (opening.get(key) === p) opening.delete(key);
  });
  opening.set(key, p);
  return p;
}

async function openSessionNow(runtime: CodexRuntime, key: string, cwd: string, log?: (line: string) => void): Promise<LiveCodex> {
  const s: LiveCodex = { key, cwd, server: null as unknown as CodexAppServer, ready: Promise.resolve(), threadId: null, turn: null, fileChanges: new Map(), dead: false, idleTimer: null, log };
  const server = new CodexAppServer({
    log,
    onNotification: (method, params) => handleNotification(s, method, params),
    onServerRequest: (method, params) => handleServerRequest(s, method, params),
    onExit: (code, error) => {
      if (live.get(key) === s) live.delete(key);
      s.dead = true;
      if (s.idleTimer) clearTimeout(s.idleTimer);
      s.turn?.reject(new Error(error ?? `Codex 프로세스가 끝났습니다 (${code ?? "?"})`));
      s.turn = null;
    },
  });
  s.server = server;
  await server.start(runtime.codexPath, runtime.env, cwd);
  live.set(key, s);
  return s;
}

function handleNotification(s: LiveCodex, method: string, params: Record<string, unknown>) {
  const t = s.turn;
  if (method === "thread/started") {
    const th = params.thread as { id?: string } | undefined;
    if (th?.id) s.threadId = th.id;
    return;
  }
  if (!t) return;
  // 이 스레드·이 턴의 알림만. turnId 가 아직 없으면(turn/start 응답 전) 스레드 기준으로 받는다.
  if (params.threadId && s.threadId && params.threadId !== s.threadId) return;
  if (t.turnId && params.turnId && params.turnId !== t.turnId) return;
  trackFileChanges(s, method, params);
  for (const e of mapAppServerNotification(method, params, Date.now(), t.ctx)) t.req.onEvent(e);
  if (method === "turn/completed") {
    s.turn = null;
    t.resolve();
  }
}

/** fileChange 아이템의 변경 내용을 아이템이 사는 동안 기억한다(item/started → patchUpdated → item/completed). */
function trackFileChanges(s: LiveCodex, method: string, params: Record<string, unknown>) {
  if (method === "item/fileChange/patchUpdated") {
    if (typeof params.itemId === "string") s.fileChanges.set(params.itemId, normalizeFileChanges(params.changes));
    return;
  }
  if (method !== "item/started" && method !== "item/completed") return;
  const item = params.item as { type?: string; id?: string; changes?: unknown } | undefined;
  if (item?.type !== "fileChange" || typeof item.id !== "string") return;
  if (method === "item/started") s.fileChanges.set(item.id, normalizeFileChanges(item.changes));
  else s.fileChanges.delete(item.id);
}

/** 승인 요청 → 앱의 권한 카드. 답이 allow 면 accept(always 면 acceptForSession), 아니면 decline. 진행 중인 턴이 없으면 거부. */
async function handleServerRequest(s: LiveCodex, method: string, params: Record<string, unknown>): Promise<unknown> {
  const t = s.turn;
  if (!t || !t.req.requestPermission) throw new Error("진행 중인 턴이 없어 승인할 수 없습니다.");
  const itemId = typeof params.itemId === "string" ? params.itemId : `req-${Date.now()}`;
  const ask = async (tool: string, title: string, input: Record<string, unknown>, description?: string) => {
    const requestId = `${itemId}#${++t.permissionSeq}`;
    const event: PermissionRequestEvent = {
      type: "permission_request",
      ts: Date.now(),
      requestId,
      toolUseId: itemId,
      tool,
      input,
      title,
      description,
      canAlwaysAllow: true,
    };
    t.req.onEvent(event);
    t.req.onEvent({ type: "status", ts: Date.now(), status: "waiting_permission" });
    const answer = await t.req.requestPermission!(event);
    t.req.onEvent({ type: "permission_resolved", ts: Date.now(), requestId, behavior: answer.behavior });
    t.req.onEvent({ type: "status", ts: Date.now(), status: "running" });
    return answer;
  };
  switch (method) {
    case "item/commandExecution/requestApproval": {
      const a = await ask("Bash", "명령 실행을 허용할까요?", { command: params.command ?? "", cwd: params.cwd ?? "" }, typeof params.reason === "string" ? params.reason : undefined);
      if (t.req.abort.signal.aborted) return { decision: "cancel" };
      return { decision: a.behavior === "allow" ? (a.always ? "acceptForSession" : "accept") : "decline" };
    }
    case "item/fileChange/requestApproval": {
      // 요청 자체엔 변경 내용이 없다 — 같은 itemId 의 item/started 에서 받아 둔 changes(경로·종류·diff)를 붙인다.
      const changes = s.fileChanges.get(itemId) ?? [];
      const title = changes.length > 0 ? `파일 ${changes.length}개 변경을 허용할까요?` : "파일 변경을 허용할까요?";
      const a = await ask("ApplyPatch", title, { changes, grantRoot: params.grantRoot ?? "" }, typeof params.reason === "string" ? params.reason : undefined);
      if (t.req.abort.signal.aborted) return { decision: "cancel" };
      return { decision: a.behavior === "allow" ? (a.always ? "acceptForSession" : "accept") : "decline" };
    }
    case "item/permissions/requestApproval": {
      const a = await ask("권한", "추가 권한을 허용할까요?", { permissions: params.permissions ?? {} }, typeof params.reason === "string" ? params.reason : undefined);
      if (a.behavior !== "allow") throw new Error("사용자가 이 작업을 거부했습니다.");
      return { permissions: params.permissions ?? {}, scope: "turn" };
    }
    default:
      // 사용자 입력 요청·MCP elicitation 등은 아직 UI 가 없다 — 거부로 답해 턴이 멈추지 않게 한다.
      throw new Error(`지원하지 않는 요청: ${method}`);
  }
}

/** 스레드가 맞지 않으면(cwd·세션 id 다름) 내리고 새로 연다. 스레드는 첫 턴 전에 start/resume 해 둔다. */
async function sessionFor(runtime: CodexRuntime, req: Pick<CodexTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log">): Promise<LiveCodex> {
  const inflight = opening.get(req.sessionKey);
  if (inflight) await inflight.catch(() => {});
  const cur = live.get(req.sessionKey);
  if (cur && !cur.dead) {
    await cur.ready.catch(() => {}); // 예열이 스레드를 여는 중이면 끝날 때까지
    const sameThread = req.sessionId === null || cur.threadId === null || req.sessionId === cur.threadId;
    if (cur.cwd === req.cwd && sameThread && cur.threadId) return cur;
    if (cur.turn) return cur;
    closeCodexSession(req.sessionKey);
  }
  const s = await openSession(runtime, req.sessionKey, req.cwd, req.log);
  if (s.threadId) return s;
  // 스레드 열기를 ready 로 묶는다 — 같은 키의 다른 호출은 위에서 이걸 기다린다.
  s.ready = openThread(s, req).catch((e) => {
    closeCodexSession(s.key);
    throw e;
  });
  await s.ready;
  return s;
}

async function openThread(s: LiveCodex, req: Pick<CodexTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log"> & { onEvent?: CodexTurnRequest["onEvent"] }): Promise<void> {
  const map = POLICY_TO_APPSERVER[req.policy];
  const base = { cwd: req.cwd, model: req.model ?? null, approvalPolicy: map.approvalPolicy, sandbox: map.sandbox };
  if (req.sessionId) {
    try {
      // 기록은 앱이 갖고 있으니 지난 턴 내용은 받지 않는다(전체 히스토리 하이드레이션은 deprecated).
      const r = await s.server.request<{ thread?: { id?: string } }>("thread/resume", { ...base, threadId: req.sessionId, excludeTurns: true });
      s.threadId = r.thread?.id ?? req.sessionId;
      return;
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      if (classifyResumeFailure(detail) === "conflict") {
        // 다른 Codex 가 스레드를 잡고 있다: 새 스레드로 갈아타면 대화 맥락을 잃으니 턴을 실패시키고 세션 id 는 지킨다.
        req.log?.(`[codex ${req.sessionKey}] resume 충돌(다른 writer): ${detail}`);
        throw new Error(resumeConflictMessage(req.sessionId, detail));
      }
      // 스레드가 정말 없으면 새로 시작한다(기록은 앱 쪽에 남아 있다). 사용자에게는 한 줄 알린다.
      req.log?.(`[codex ${req.sessionKey}] resume 실패 → 새 스레드: ${detail}`);
      req.onEvent?.({ type: "error", ts: Date.now(), fatal: false, message: `이전 Codex 스레드(${req.sessionId.slice(0, 8)}…)를 찾지 못해 새 스레드로 시작합니다. 화면의 대화는 남지만 Codex 는 이전 맥락을 모릅니다. (${detail})` });
    }
  }
  const r = await s.server.request<{ thread?: { id?: string } }>("thread/start", base);
  s.threadId = r.thread?.id ?? null;
  if (!s.threadId) throw new Error("Codex 스레드를 열지 못했습니다.");
}

export type CodexWarmRequest = Pick<CodexTurnRequest, "sessionKey" | "cwd" | "sessionId" | "policy" | "model" | "log">;

/** 예열: 프로세스와 스레드를 미리 열어 둔다. app-server 를 못 쓰면 아무것도 안 한다. */
export async function warmCodexSession(runtime: CodexRuntime, req: CodexWarmRequest): Promise<"reused" | "opened" | "unavailable"> {
  if (appServerUnavailable) return "unavailable";
  if (opening.has(req.sessionKey)) return "reused";
  const cur = live.get(req.sessionKey);
  if (cur && !cur.dead && cur.cwd === req.cwd) return "reused";
  try {
    const s = await sessionFor(runtime, req);
    armIdle(s);
    return "opened";
  } catch (e) {
    markUnavailableIfStartupFailure(e, req.log);
    return "unavailable";
  }
}

function markUnavailableIfStartupFailure(e: unknown, log?: (line: string) => void) {
  const msg = e instanceof Error ? e.message : String(e);
  // 서브커맨드가 없거나(옛 CLI) 프로세스를 못 띄운 경우만 폴백으로 고정. 스레드/턴 오류는 그때그때.
  if (/unrecognized subcommand|unexpected argument|ENOENT|spawn|app-server 가 끝났습니다|응답 없음: initialize/i.test(msg)) {
    appServerUnavailable = msg;
    log?.(`[codex] app-server 를 쓸 수 없어 exec 로 폴백합니다: ${msg}`);
  }
}

export async function runCodexTurn(runtime: CodexRuntime, req: CodexTurnRequest): Promise<void> {
  if (req.abort.signal.aborted) throw new Error("중단됨");
  if (appServerUnavailable) return runCodexTurnExec(runtime, req);
  let s: LiveCodex;
  try {
    s = await sessionFor(runtime, req);
  } catch (e) {
    markUnavailableIfStartupFailure(e, req.log);
    if (appServerUnavailable) return runCodexTurnExec(runtime, req);
    throw e;
  }
  if (!s.threadId) throw new Error("Codex 스레드를 열지 못했습니다.");
  if (s.idleTimer) {
    clearTimeout(s.idleTimer);
    s.idleTimer = null;
  }
  // 스레드 id 를 세션 id 로 알린다(새 스레드면 이때 처음 알게 된다).
  if (s.threadId !== req.sessionId) req.onEvent({ type: "session", ts: Date.now(), sessionId: s.threadId, provider: "codex", model: req.model });

  const done = new Promise<void>((resolve, reject) => {
    s.turn = { req, turnId: null, ctx: { model: req.model, startedAt: Date.now(), lastUsage: null }, resolve, reject, permissionSeq: 0 };
  });
  const turn = s.turn!;
  let graceTimer: ReturnType<typeof setTimeout> | null = null;
  const onAbort = () => {
    if (turn.turnId) void s.server.request("turn/interrupt", { threadId: s.threadId, turnId: turn.turnId }, 10_000).catch(() => {});
    graceTimer = setTimeout(() => {
      if (s.turn === turn) closeCodexSession(s.key);
    }, INTERRUPT_GRACE_MS);
  };
  req.abort.signal.addEventListener("abort", onAbort, { once: true });
  try {
    const map = POLICY_TO_APPSERVER[req.policy];
    const input: Record<string, unknown>[] = [
      ...req.images.map((i) => ({ type: "localImage", path: i.filePath })),
      { type: "text", text: req.prompt },
    ];
    const r = await s.server.request<{ turn?: { id?: string } }>("turn/start", {
      threadId: s.threadId,
      input,
      cwd: req.cwd,
      model: req.model ?? null,
      approvalPolicy: map.approvalPolicy,
      sandboxPolicy: map.sandboxPolicy,
    });
    turn.turnId = r.turn?.id ?? null;
    if (req.abort.signal.aborted) onAbort();
    await done;
  } finally {
    req.abort.signal.removeEventListener("abort", onAbort);
    if (graceTimer) clearTimeout(graceTimer);
    if (s.turn === turn) s.turn = null;
    if (live.get(s.key) === s && !s.dead) armIdle(s);
  }
}

/** 폴백: SDK exec 경로. 한 턴 = runStreamed 한 번, thread.started 의 id 로 다음 턴 resumeThread. */
export async function runCodexTurnExec(runtime: CodexRuntime, req: CodexTurnRequest): Promise<void> {
  const { Codex } = await importCodexSdk();
  const codex = new Codex({ codexPathOverride: runtime.codexPath, env: runtime.env });
  const threadOptions: ThreadOptions = {
    workingDirectory: req.cwd,
    skipGitRepoCheck: true,
    approvalPolicy: "never",
    model: req.model,
    ...POLICY_TO_THREAD[req.policy],
  };
  const thread = req.sessionId ? codex.resumeThread(req.sessionId, threadOptions) : codex.startThread(threadOptions);
  const input = req.images.length > 0 ? buildCodexInput(req.images.map((i) => i.filePath), req.prompt) : req.prompt;
  const ctx = { model: req.model, startedAt: Date.now() };
  let streamed = false;
  try {
    const { events } = await thread.runStreamed(input, { signal: req.abort.signal });
    for await (const event of events) {
      streamed = true;
      for (const e of mapCodexEvent(event, Date.now(), ctx)) req.onEvent(e);
    }
  } catch (e) {
    if (req.abort.signal.aborted) throw e;
    const msg = e instanceof Error ? e.message : String(e);
    if (!streamed && /experimental-json|unexpected argument|unrecognized|invalid.*argument/i.test(msg)) {
      throw new Error("codex CLI 버전이 오래되어 SDK 연동을 지원하지 않습니다. 업데이트가 필요합니다: npm i -g @openai/codex@latest");
    }
    throw e;
  }
  if (typeof thread.id === "string" && thread.id && thread.id !== req.sessionId) {
    req.onEvent({ type: "session", ts: Date.now(), sessionId: thread.id, provider: "codex", model: req.model });
  }
}
