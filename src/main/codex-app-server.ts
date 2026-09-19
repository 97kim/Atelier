// `codex app-server` 클라이언트. JSON-RPC 2.0 을 한 줄 JSON(JSONL)로 stdio 에 주고받는다.
// 프로세스 하나가 스레드(대화)를 여러 턴에 걸쳐 살려 두므로, 턴마다 `codex exec` 를 새로 띄우던 SDK 경로보다 기동·MCP 연결 비용을
// 세션당 한 번만 낸다. 승인(명령 실행·파일 변경)은 서버가 요청(ServerRequest)으로 물어 오고 우리가 응답한다 — exec 모드에는 없던 것.
// 프로토콜 형태는 `codex app-server generate-json-schema` 결과(0.153)를 따른다.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ChatEvent, ModelUsageEntry, TokenUsage } from "@shared/chat-events";

type Json = Record<string, unknown>;

export interface AppServerHandlers {
  /** 서버 알림(method + params). 턴 라우팅은 어댑터가 한다. */
  onNotification(method: string, params: Json): void;
  /** 서버가 우리에게 묻는 요청(승인 등). 돌려준 값이 result 로 나간다. 거부는 throw. */
  onServerRequest(method: string, params: Json): Promise<unknown>;
  onExit(code: number | null, error?: string): void;
  log?(line: string): void;
}

interface Pending {
  resolve(v: unknown): void;
  reject(e: unknown): void;
  timer: ReturnType<typeof setTimeout>;
}

const REQUEST_TIMEOUT_MS = 120_000;

export class CodexAppServer {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private buffer = "";
  private seq = 0;
  private readonly pending = new Map<number, Pending>();
  private ended = false;

  constructor(private readonly handlers: AppServerHandlers) {}

  get alive(): boolean {
    return this.proc !== null && !this.ended;
  }

  /** 프로세스를 띄우고 initialize 핸드셰이크까지 끝낸다. */
  async start(codexPath: string, env: Record<string, string>, cwd: string): Promise<void> {
    const proc = spawn(codexPath, [...reasoningSummaryArgs(env), "app-server"], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    this.proc = proc;
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => this.onData(chunk));
    proc.stderr.on("data", (chunk: Buffer) => this.handlers.log?.(`[codex app-server] ${chunk.toString().trim().slice(0, 300)}`));
    proc.stdin.on("error", (e) => this.handlers.log?.(`[codex app-server] stdin ${e.message}`));
    const end = (code: number | null, error?: string) => {
      if (this.ended) return;
      this.ended = true;
      for (const p of this.pending.values()) {
        clearTimeout(p.timer);
        p.reject(new Error(error ?? `codex app-server 가 끝났습니다 (${code ?? "?"})`));
      }
      this.pending.clear();
      this.handlers.onExit(code, error);
    };
    proc.on("exit", (code) => end(code));
    proc.on("error", (e) => end(null, e.message));
    await this.request("initialize", {
      clientInfo: { name: "atelier", title: "Atelier", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized", {});
  }

  request<T = unknown>(method: string, params: Json, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
    if (!this.alive) return Promise.reject(new Error("codex app-server 가 실행 중이 아닙니다."));
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`codex app-server 응답 없음: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  notify(method: string, params: Json): void {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    if (!this.proc) return;
    this.ended = true;
    try {
      this.proc.stdin.end();
    } catch {
      /* 무시 */
    }
    try {
      this.proc.kill();
    } catch {
      /* 이미 죽음 */
    }
  }

  private write(msg: Json) {
    const p = this.proc;
    if (!p || p.stdin.destroyed || !p.stdin.writable) return;
    p.stdin.write(`${JSON.stringify(msg)}\n`);
  }

  private onData(chunk: string) {
    this.buffer += chunk;
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) return;
      const line = this.buffer.slice(0, nl).trim();
      this.buffer = this.buffer.slice(nl + 1);
      if (!line) continue;
      let msg: Json;
      try {
        msg = JSON.parse(line) as Json;
      } catch {
        this.handlers.log?.(`[codex app-server] 깨진 줄: ${line.slice(0, 120)}`);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: Json) {
    const id = msg.id;
    const method = typeof msg.method === "string" ? msg.method : null;
    if (method && id !== undefined && id !== null) {
      // 서버 → 클라이언트 요청(승인 등)
      void this.handlers
        .onServerRequest(method, (msg.params ?? {}) as Json)
        .then((result) => this.write({ jsonrpc: "2.0", id: id as number | string, result: result ?? {} }))
        .catch((e) => this.write({ jsonrpc: "2.0", id: id as number | string, error: { code: -32000, message: e instanceof Error ? e.message : String(e) } }));
      return;
    }
    if (method) {
      this.handlers.onNotification(method, (msg.params ?? {}) as Json);
      return;
    }
    if (typeof id === "number") {
      const p = this.pending.get(id);
      if (!p) return;
      this.pending.delete(id);
      clearTimeout(p.timer);
      if (msg.error) {
        const err = msg.error as { message?: string; code?: number };
        p.reject(new Error(err.message ?? `codex app-server 오류 ${err.code ?? ""}`));
      } else p.resolve(msg.result);
    }
  }
}

// ===== 알림 → ChatEvent =====

export interface AppServerTurnContext {
  model?: string;
  startedAt: number;
  /** 마지막으로 받은 thread/tokenUsage/updated 의 last. turn/completed 때 사용량으로 쓴다. */
  lastUsage: TokenUsage | null;
}

interface Item {
  type: string;
  id: string;
  [k: string]: unknown;
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

export function appServerUsage(last: unknown): TokenUsage {
  const u = (last ?? {}) as Record<string, unknown>;
  const n = (k: string) => (typeof u[k] === "number" ? (u[k] as number) : 0);
  const cached = n("cachedInputTokens");
  return { input: Math.max(0, n("inputTokens") - cached), output: n("outputTokens"), cacheRead: cached, cacheWrite: n("cacheWriteInputTokens") };
}

/** 하나의 턴에 속한 알림을 ChatEvent 로. 턴 밖 알림(다른 threadId·turnId)은 호출 전에 걸러 준다. */
export function mapAppServerNotification(method: string, params: Json, ts: number, ctx: AppServerTurnContext): ChatEvent[] {
  switch (method) {
    case "item/agentMessage/delta":
      return [{ type: "text_delta", ts, blockId: str(params.itemId), text: str(params.delta) }];
    case "item/reasoning/summaryTextDelta":
      return params.delta ? [{ type: "thinking_delta", ts, text: str(params.delta) }] : [];
    case "item/reasoning/summaryPartAdded":
      // 요약 단락 경계 — 화면에서 줄을 나눠 보이게만
      return [{ type: "thinking_delta", ts, text: "\n" }];
    case "item/started":
      return itemStarted(params.item as Item, ts);
    case "item/completed":
      return itemCompleted(params.item as Item, ts);
    case "thread/tokenUsage/updated": {
      const tu = params.tokenUsage as { last?: unknown } | undefined;
      if (tu?.last) ctx.lastUsage = appServerUsage(tu.last);
      return [];
    }
    case "turn/completed": {
      const turn = (params.turn ?? {}) as { status?: string; error?: { message?: string } | null };
      const usage = ctx.lastUsage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      const modelUsage: Record<string, ModelUsageEntry> = ctx.model ? { [ctx.model]: { ...usage, costUsd: 0 } } : {};
      // 중단(interrupted)을 성공으로 읽으면 안 된다. 예약 회차에서는 "사용자가 세운 것" 이
      // 그대로 completed 로 기록된다.
      const failed = turn.status === "failed" || turn.status === "interrupted";
      return [
        {
          type: "turn_result",
          ts,
          usage,
          costUsd: 0,
          durationMs: Math.max(0, ts - ctx.startedAt),
          numTurns: 1,
          modelUsage,
          isError: failed,
          errorText: failed ? (turn.error?.message ?? (turn.status === "interrupted" ? "중단되었습니다." : "Codex turn 실패")) : undefined,
        },
      ];
    }
    case "error": {
      const err = (params.error ?? {}) as { message?: string };
      return [{ type: "error", ts, message: err.message || "Codex 오류", fatal: false }];
    }
    default:
      return [];
  }
}

/** fileChange 아이템의 변경 하나. kind 는 add/delete/update, diff 는 unified diff(add 는 + 줄만). ApplyPatch 카드·승인 카드가 그대로 쓴다. */
export interface FileChangeDto {
  path: string;
  kind: string;
  diff: string;
}

export function normalizeFileChanges(raw: unknown): FileChangeDto[] {
  const list = (Array.isArray(raw) ? raw : []) as { path?: string; kind?: { type?: string } | string; diff?: string }[];
  const kindOf = (k: unknown) => (typeof k === "string" ? k : ((k as { type?: string })?.type ?? "update"));
  return list.map((c) => ({ path: str(c.path), kind: kindOf(c.kind), diff: str(c.diff) }));
}

function itemStarted(item: Item, ts: number): ChatEvent[] {
  switch (item.type) {
    case "commandExecution":
      return [{ type: "tool_use", ts, toolUseId: item.id, name: "Bash", input: { command: str(item.command) } }];
    case "mcpToolCall":
      return [{ type: "tool_use", ts, toolUseId: item.id, name: `${str(item.server)}:${str(item.tool)}`, input: (item.arguments as Record<string, unknown>) ?? {} }];
    case "webSearch":
      return [{ type: "tool_use", ts, toolUseId: item.id, name: "WebSearch", input: { query: str(item.query) } }];
    default:
      return [];
  }
}

function itemCompleted(item: Item, ts: number): ChatEvent[] {
  switch (item.type) {
    case "agentMessage":
      return [{ type: "assistant_text", ts, blockId: item.id, text: str(item.text) }];
    case "commandExecution": {
      const exit = typeof item.exitCode === "number" ? item.exitCode : null;
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "Bash", input: { command: str(item.command) } },
        {
          type: "tool_result",
          ts,
          toolUseId: item.id,
          output: str(item.aggregatedOutput),
          isError: item.status === "failed" || item.status === "declined" || (exit !== null && exit !== 0),
        },
      ];
    }
    case "fileChange": {
      const changes = normalizeFileChanges(item.changes);
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "ApplyPatch", input: { changes } },
        { type: "tool_result", ts, toolUseId: item.id, output: changes.map((c) => `${c.kind} ${c.path}`).join("\n"), isError: item.status === "failed" || item.status === "declined" },
      ];
    }
    case "mcpToolCall": {
      const error = item.error as { message?: string } | null | undefined;
      const result = item.result as { content?: unknown[]; structuredContent?: unknown } | null | undefined;
      let output = "";
      if (error?.message) output = error.message;
      else if (result) {
        const parts = (Array.isArray(result.content) ? result.content : [])
          .map((c) => {
            const b = c as { type?: string; text?: string };
            return b?.type === "text" ? (b.text ?? "") : JSON.stringify(c);
          })
          .filter(Boolean);
        output = parts.length > 0 ? parts.join("\n") : result.structuredContent !== undefined ? JSON.stringify(result.structuredContent, null, 2) : "";
      }
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: `${str(item.server)}:${str(item.tool)}`, input: (item.arguments as Record<string, unknown>) ?? {} },
        { type: "tool_result", ts, toolUseId: item.id, output, isError: item.status === "failed" },
      ];
    }
    case "webSearch":
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "WebSearch", input: { query: str(item.query) } },
        { type: "tool_result", ts, toolUseId: item.id, output: "", isError: false },
      ];
    case "plan":
      return [{ type: "tool_use", ts, toolUseId: item.id, name: "TodoWrite", input: { plan: str(item.text) } }, { type: "tool_result", ts, toolUseId: item.id, output: str(item.text), isError: false }];
    default:
      // userMessage(우리가 보낸 것)·reasoning 등은 노출하지 않는다.
      return [];
  }
}

/**
 * 채팅의 "생각 중" 에 reasoning 요약을 흘리려면 Codex 가 요약을 만들어야 한다(item/reasoning/summaryTextDelta).
 * 기본값은 요약 없음이라, 사용자가 config.toml 에 model_reasoning_summary 를 직접 정하지 않았을 때만 "auto" 를 넘긴다.
 */
export function reasoningSummaryArgs(env: Record<string, string | undefined>, configText?: string): string[] {
  let text = configText;
  if (text === undefined) {
    try {
      text = readFileSync(join(env.CODEX_HOME || join(homedir(), ".codex"), "config.toml"), "utf8");
    } catch {
      text = "";
    }
  }
  // 최상위 키만 본다(프로파일 [profiles.x] 안의 값은 활성 프로파일에 따라 다르지만, 사용자가 손댔다면 존중).
  if (/^\s*model_reasoning_summary\s*=/m.test(text)) return [];
  return ["-c", 'model_reasoning_summary="auto"'];
}

/**
 * thread/resume 실패의 종류. "conflict" 는 Codex 0.154+ 의 thread-store 가 같은 스레드에 writer 둘을 막은 것 —
 * 다른 Codex(터미널 TUI 등)가 그 스레드를 쓰는 중이다. 이때 새 스레드로 갈아타면 대화 맥락을 잃으므로 턴을 실패시켜야 한다.
 * 그 밖(스레드 없음·손상)은 새 스레드로 시작해도 된다.
 */
export function classifyResumeFailure(message: string): "conflict" | "missing" {
  return /active writer|thread-store conflict/i.test(message) ? "conflict" : "missing";
}

export function resumeConflictMessage(threadId: string, detail: string): string {
  return `이전 Codex 스레드(${threadId.slice(0, 8)}…)를 다른 Codex 가 쓰는 중입니다. 터미널에서 \`codex resume\` 으로 연 TUI 가 있으면 그쪽을 /exit 로 닫고 다시 보내세요. 이 탭의 세션은 그대로 둡니다. (${detail})`;
}
