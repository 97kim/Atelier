// @openai/codex-sdk ThreadEvent → 공통 ChatEvent 매핑. 부수효과 없는 순수 함수 (codex-events.test.ts).
//
// Codex 는 토큰 단위 스트림이 없고 item 단위로 온다. 명령 실행은 item.started 에서 tool_use 로
// 카드를 먼저 띄우고, item.completed 에서 출력을 채운다. 툴 이름은 Claude 와 같은 카드가
// 그려지도록 Bash / ApplyPatch / WebSearch / TodoWrite 로 맞춘다.

import type { ChatEvent, ModelUsageEntry, TokenUsage } from "@shared/chat-events";

type ThreadEvent = import("@openai/codex-sdk").ThreadEvent;
type ThreadItem = import("@openai/codex-sdk").ThreadItem;
type Usage = import("@openai/codex-sdk").Usage;

export interface CodexTurnContext {
  model?: string;
  startedAt: number;
}

export function mapCodexEvent(event: ThreadEvent, ts: number, ctx: CodexTurnContext): ChatEvent[] {
  switch (event.type) {
    case "thread.started":
      return [{ type: "session", ts, sessionId: event.thread_id, provider: "codex", model: ctx.model }];
    case "turn.completed":
      return [turnResult(event.usage, ts, ctx)];
    case "turn.failed":
      return [{ type: "error", ts, message: event.error?.message || "Codex turn 실패" }];
    case "error":
      return [{ type: "error", ts, message: event.message || "Codex 오류" }];
    case "item.started":
      return itemStarted(event.item, ts);
    case "item.completed":
      return itemCompleted(event.item, ts);
    default:
      // turn.started / item.updated 는 UI 에 노이즈.
      return [];
  }
}

export function codexUsage(u: Usage | null | undefined): TokenUsage {
  if (!u) return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const cached = u.cached_input_tokens ?? 0;
  return {
    // OpenAI 의 input_tokens 는 캐시 히트를 포함하므로 비캐시 입력만 남긴다.
    input: Math.max(0, (u.input_tokens ?? 0) - cached),
    output: u.output_tokens ?? 0,
    cacheRead: cached,
    cacheWrite: u.cache_write_input_tokens ?? 0,
  };
}

function turnResult(usage: Usage | null | undefined, ts: number, ctx: CodexTurnContext): ChatEvent {
  const u = codexUsage(usage);
  const modelUsage: Record<string, ModelUsageEntry> = ctx.model
    ? { [ctx.model]: { ...u, costUsd: 0 } }
    : {};
  return {
    type: "turn_result",
    ts,
    usage: u,
    // Codex SDK 는 비용을 주지 않는다. Phase 4 가격표에서 환산한다.
    costUsd: 0,
    durationMs: Math.max(0, ts - ctx.startedAt),
    numTurns: 1,
    modelUsage,
    isError: false,
  };
}

function itemStarted(item: ThreadItem, ts: number): ChatEvent[] {
  switch (item.type) {
    case "command_execution":
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "Bash", input: { command: item.command } },
      ];
    case "mcp_tool_call":
      return [
        {
          type: "tool_use",
          ts,
          toolUseId: item.id,
          name: `${item.server}:${item.tool}`,
          input: item.arguments ?? {},
        },
      ];
    case "web_search":
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "WebSearch", input: { query: item.query } },
      ];
    default:
      return [];
  }
}

function itemCompleted(item: ThreadItem, ts: number): ChatEvent[] {
  switch (item.type) {
    case "agent_message":
      return [{ type: "assistant_text", ts, blockId: item.id, text: item.text }];
    case "command_execution":
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "Bash", input: { command: item.command } },
        {
          type: "tool_result",
          ts,
          toolUseId: item.id,
          output: item.aggregated_output ?? "",
          isError:
            item.status === "failed" || (item.exit_code !== undefined && item.exit_code !== 0),
        },
      ];
    case "file_change":
      return [
        {
          type: "tool_use",
          ts,
          toolUseId: item.id,
          name: "ApplyPatch",
          input: { changes: item.changes },
        },
        {
          type: "tool_result",
          ts,
          toolUseId: item.id,
          output: item.changes.map((c) => `${c.kind} ${c.path}`).join("\n"),
          isError: item.status === "failed",
        },
      ];
    case "mcp_tool_call": {
      const output =
        item.error !== undefined
          ? item.error.message
          : item.result !== undefined
            ? mcpResultText(item.result)
            : "";
      return [
        {
          type: "tool_use",
          ts,
          toolUseId: item.id,
          name: `${item.server}:${item.tool}`,
          input: item.arguments ?? {},
        },
        { type: "tool_result", ts, toolUseId: item.id, output, isError: item.status === "failed" },
      ];
    }
    case "web_search":
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "WebSearch", input: { query: item.query } },
        { type: "tool_result", ts, toolUseId: item.id, output: "", isError: false },
      ];
    case "todo_list":
      return [
        { type: "tool_use", ts, toolUseId: item.id, name: "TodoWrite", input: { items: item.items } },
        { type: "tool_result", ts, toolUseId: item.id, output: "", isError: false },
      ];
    case "error":
      return [{ type: "error", ts, message: item.message, fatal: false }];
    default:
      // reasoning 은 노출하지 않는다.
      return [];
  }
}

function mcpResultText(result: { content: unknown; structured_content: unknown }): string {
  if (Array.isArray(result.content)) {
    const parts = result.content
      .map((c) => {
        const b = c as { type?: string; text?: string };
        return b.type === "text" ? (b.text ?? "") : JSON.stringify(c);
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("\n");
  }
  if (result.structured_content !== undefined) {
    return JSON.stringify(result.structured_content, null, 2);
  }
  return "";
}
