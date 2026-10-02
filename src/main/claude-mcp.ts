// MCP 서버 상태 조회. 터미널 /mcp 화면이 보여주는 것(연결 상태·에러·도구 목록)을 SDK 컨트롤 요청으로 받는다.
// 서버 연결은 CLI 시작 뒤 몇 초 걸리므로 pending 이 남아 있으면 잠깐 폴링한다.

import type { McpServerStatusDto } from "@shared/ipc";
import type { ClaudeRuntime } from "./claude-adapter";
import { withControlQuery, withTimeout } from "./claude-control";
import { mt } from "./i18n";

type McpServerStatus = import("@anthropic-ai/claude-agent-sdk").McpServerStatus;

const SETTLE_MS = 10_000;
const POLL_MS = 800;

export async function fetchMcpStatus(
  runtime: ClaudeRuntime,
  cwd: string,
  log?: (line: string) => void,
): Promise<McpServerStatusDto[]> {
  return withControlQuery(
    runtime,
    cwd,
    async (q) => {
      const started = Date.now();
      let servers = await withTimeout(q.mcpServerStatus(), 15_000, mt("session.error.label.mcpStatus"));
      while (servers.some((s) => s.status === "pending") && Date.now() - started < SETTLE_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        servers = await withTimeout(q.mcpServerStatus(), 15_000, mt("session.error.label.mcpStatus"));
      }
      return servers.map(toDto).sort((a, b) => a.name.localeCompare(b.name));
    },
    log,
  );
}

export function toDto(s: McpServerStatus): McpServerStatusDto {
  const cfg = s.config as
    | { type?: string; command?: string; args?: string[]; url?: string }
    | undefined;
  const transport = cfg?.type ?? (cfg?.command ? "stdio" : undefined);
  const target = cfg?.command ? [cfg.command, ...(cfg.args ?? [])].join(" ") : cfg?.url;
  return {
    name: s.name,
    status: s.status,
    error: s.error,
    scope: s.scope,
    serverInfo: s.serverInfo,
    transport,
    target,
    tools: (s.tools ?? []).map((t) => ({ name: t.name, description: t.description })),
  };
}
