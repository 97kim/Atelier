// 커밋 메시지 초안: 고른 파일의 diff 를 Claude(haiku) 에 한 번 보내 제목+본문을 받는다.
// 대화 세션과 분리된 일회성 query 라 채팅 기록에 남지 않는다. 툴은 쓰지 않는다.

import type { GitDraftResult } from "@shared/ipc";
import type { ClaudeRuntime } from "./claude-adapter";
import { importClaudeSdk } from "./esm";
import { gitDiffFor, gitRecentSubjects } from "./git";
import { mt } from "./i18n";

export const DRAFT_MODEL = "haiku";

export function buildDraftPrompt(diff: string, recentSubjects: string[]): string {
  // i18n-ignore: prompt
  const style =
    recentSubjects.length > 0
      ? `이 저장소의 최근 커밋 제목(스타일·언어를 따르세요):\n${recentSubjects.map((s) => `- ${s}`).join("\n")}\n\n`
      : "";
  return (
    // i18n-ignore: prompt
    `${style}아래 diff 에 대한 git 커밋 메시지를 작성하세요.\n` +
    `규칙: 첫 줄은 72자 이내의 제목(마침표 없음). 변경이 여러 갈래면 빈 줄 뒤에 "- " 불릿 본문을 2~5줄. ` +
    `무엇을 왜 바꿨는지에 집중하고, 파일 이름 나열이나 "이 커밋은" 같은 서두는 쓰지 마세요. ` +
    `출력은 그대로 커밋 메시지로 쓰입니다. 인사·설명·"커밋 메시지:" 같은 머리말·코드 펜스 없이 메시지 본문만 쓰세요.\n\n` +
    `\`\`\`diff\n${diff}\n\`\`\``
  );
}

/**
 * 모델 출력에서 커밋 메시지만 남긴다. 펜스가 있으면 첫 펜스 안쪽이 메시지다(모델이 설명을 곁들이는 경우).
 * 펜스가 없으면 "커밋 메시지:" 류의 머리말 줄을 걷어낸다.
 */
export function cleanDraft(text: string): string {
  let t = text.trim();
  const fence = t.match(/```[a-z]*\n([\s\S]*?)\n```/);
  if (fence) t = fence[1].trim();
  else {
    const lines = t.split("\n");
    while (lines.length > 1 && /^[^\n]{0,40}[:：]\s*$/.test(lines[0])) lines.shift();
    t = lines.join("\n").trim();
  }
  return t.replace(/\n{3,}/g, "\n\n");
}

export async function draftCommitMessage(
  runtime: ClaudeRuntime,
  cwd: string,
  paths: string[],
  signal?: AbortSignal,
): Promise<GitDraftResult> {
  const [diff, subjects] = await Promise.all([
    gitDiffFor(cwd, runtime.env, paths),
    gitRecentSubjects(cwd, runtime.env),
  ]);
  if (!diff.trim()) return { ok: false, error: mt("repo.git.draft.noDiff") };
  const { query } = await importClaudeSdk();
  const abort = new AbortController();
  signal?.addEventListener("abort", () => abort.abort(), { once: true });
  const q = query({
    prompt: buildDraftPrompt(diff, subjects),
    options: {
      cwd,
      env: runtime.env,
      pathToClaudeCodeExecutable: runtime.pathToClaudeCodeExecutable,
      model: DRAFT_MODEL,
      maxTurns: 1,
      tools: [],
      permissionMode: "default",
      // 사용자 설정(훅·MCP·CLAUDE.md)을 읽지 않는다: 빠르고, 훅이 작업 디렉토리에 파일을 만들지 않는다.
      settingSources: [],
      // ~/.claude.json 의 MCP 서버도 붙이지 않는다 (연결 타임아웃이 초안 시간을 잡아먹는다).
      mcpServers: {},
      strictMcpConfig: true,
      // 일회성 호출이라 ~/.claude/projects 에 세션 기록을 남기지 않는다.
      persistSession: false,
      abortController: abort,
    },
  });
  let text = "";
  try {
    for await (const m of q) {
      if (m.type === "result") {
        if (m.subtype !== "success") return { ok: false, error: mt("repo.git.draft.noResult", { subtype: m.subtype }) };
        text = m.result;
        // 결과를 받았으면 바로 닫는다 — 프로세스 종료를 기다리면 수십 초가 더 걸린다.
        break;
      }
    }
  } catch (e) {
    return { ok: false, error: mt("repo.git.draft.failed", { detail: e instanceof Error ? e.message : String(e) }) };
  } finally {
    abort.abort();
  }
  const message = cleanDraft(text);
  return message ? { ok: true, message } : { ok: false, error: mt("repo.git.draft.empty") };
}
