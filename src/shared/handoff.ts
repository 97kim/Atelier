// provider 전환 시 이전 대화를 새 provider 의 첫 메시지로 넘기기 위한 요약. 순수 함수.
// Codex 는 Claude 세션을 이어받을 수 없으므로(그 반대도), 이벤트 로그를 텍스트로 압축해 전달한다.

import type { ChatEvent } from "./chat-events";

export interface HandoffStats {
  /** 사용자 메시지 + 완료된 어시스턴트 턴 수. */
  messages: number;
  /** 툴 입력에서 본 파일 경로(중복 제거). */
  files: number;
  /** 마지막 할 일 목록에서 완료되지 않은 항목 수. */
  pendingTasks: number;
  /** 요약 텍스트의 대략적 토큰 수 (문자 수 / 3). */
  tokensEstimate: number;
}

export interface Handoff {
  summary: string;
  stats: HandoffStats;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}...(생략)` : s);

export function extractFilePaths(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const i = input as Record<string, unknown>;
  const out: string[] = [];
  for (const k of ["file_path", "notebook_path", "path"]) if (str(i[k])) out.push(str(i[k]));
  if (Array.isArray(i.changes)) {
    for (const c of i.changes as { path?: unknown }[]) if (str(c?.path)) out.push(str(c.path));
  }
  return out;
}

/** Claude TodoWrite({todos:[{content,status}]}) 와 Codex todo_list({items:[{text,completed}]}) 모두 처리. */
export function pendingTodos(input: unknown): string[] {
  if (!input || typeof input !== "object") return [];
  const i = input as { todos?: unknown; items?: unknown };
  const out: string[] = [];
  if (Array.isArray(i.todos)) {
    for (const t of i.todos as { content?: unknown; status?: unknown }[]) {
      if (t?.status !== "completed" && str(t?.content)) out.push(str(t.content));
    }
  }
  if (Array.isArray(i.items)) {
    for (const t of i.items as { text?: unknown; completed?: unknown }[]) {
      if (t?.completed !== true && str(t?.text)) out.push(str(t.text));
    }
  }
  return out;
}

export function buildHandoff(
  events: ChatEvent[],
  opts: { cwd?: string | null; fromProvider?: string; maxChars?: number } = {},
): Handoff {
  const maxChars = opts.maxChars ?? 24000;
  const lines: string[] = [];
  const files = new Set<string>();
  let messages = 0;
  let lastTodoInput: unknown = null;
  const textBlocks = new Map<string, string>();
  const toolNames = new Map<string, string>();

  for (const e of events) {
    switch (e.type) {
      case "user_message":
        messages += 1;
        lines.push(`### 사용자\n${clip(e.text, 1200)}`);
        break;
      case "text_delta":
        textBlocks.set(e.blockId, (textBlocks.get(e.blockId) ?? "") + e.text);
        lines.push(` text:${e.blockId}`);
        break;
      case "assistant_text":
        textBlocks.set(e.blockId, e.text);
        lines.push(` text:${e.blockId}`);
        break;
      case "tool_use": {
        if (e.partial) break;
        for (const p of extractFilePaths(e.input)) files.add(p);
        if (e.name === "TodoWrite") lastTodoInput = e.input;
        if (toolNames.has(e.toolUseId)) break;
        toolNames.set(e.toolUseId, e.name);
        lines.push(`- 툴 ${e.name}: ${clip(toolOneLiner(e.name, e.input), 160)}`);
        break;
      }
      case "tool_result":
        if (e.isError) lines.push(`  - 실패: ${clip(e.output.replace(/\s+/g, " "), 160)}`);
        break;
      case "turn_result":
        if (!e.isError) messages += 1;
        break;
      default:
        break;
    }
  }

  // text_delta 여러 개를 한 블록으로 합치고, 같은 블록의 중복 마커는 첫 번째만 남긴다.
  const seenText = new Set<string>();
  const body = lines
    .filter((l) => {
      if (!l.startsWith(" text:")) return true;
      if (seenText.has(l)) return false;
      seenText.add(l);
      return true;
    })
    .map((l) =>
      l.startsWith(" text:")
        ? `### 어시스턴트\n${clip((textBlocks.get(l.slice(6)) ?? "").trim(), 1600)}`
        : l,
    )
    .filter((l) => l.trim() !== "### 어시스턴트");

  const pending = pendingTodos(lastTodoInput);
  const header = [
    `## 이전 세션 요약${opts.fromProvider ? ` (${opts.fromProvider} 에서 전환)` : ""}`,
    opts.cwd ? `작업 디렉토리: ${opts.cwd}` : "",
    files.size > 0 ? `다룬 파일: ${[...files].slice(0, 30).join(", ")}` : "",
    pending.length > 0 ? `남은 할 일:\n${pending.map((t) => `- [ ] ${t}`).join("\n")}` : "",
    "",
    "아래는 시간순 대화 기록이다. 이 맥락을 이어서 작업한다.",
    "",
  ]
    .filter((l) => l !== "")
    .join("\n");

  let summary = `${header}\n${body.join("\n\n")}`;
  if (summary.length > maxChars) {
    // 최근 내용을 우선 보존한다.
    const keep = Math.max(0, maxChars - header.length - 24);
    summary = `${header}\n...(앞부분 생략)...\n${summary.slice(summary.length - keep)}`;
  }

  return {
    summary,
    stats: {
      messages,
      files: files.size,
      pendingTasks: pending.length,
      tokensEstimate: Math.round(summary.length / 3),
    },
  };
}

function toolOneLiner(name: string, input: unknown): string {
  const i = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  switch (name) {
    case "Bash":
      return str(i.command).split("\n")[0];
    case "Edit":
    case "Write":
    case "Read":
    case "MultiEdit":
      return str(i.file_path);
    case "ApplyPatch":
      return extractFilePaths(input).join(", ");
    case "TodoWrite":
      return `미완료 ${pendingTodos(input).length}개`;
    case "Grep":
    case "Glob":
      return str(i.pattern);
    default: {
      const first = Object.values(i).find((v) => typeof v === "string");
      return typeof first === "string" ? first : JSON.stringify(i).slice(0, 120);
    }
  }
}
