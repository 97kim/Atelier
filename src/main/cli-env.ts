// CLI(Claude Code·Codex)에 넘길 환경변수 정리.
// 앱이 Claude Code 나 Codex 안의 셸에서 실행되면 그 세션의 표식(CLAUDECODE, CLAUDE_CODE_CHILD_SESSION, CODEX_SANDBOX …)이 상속되고,
// 그걸 본 CLI 는 자기를 "중첩 세션" 으로 여겨 기록 저장을 끄거나(Transcript saving is off) 샌드박스 안이라고 판단한다.
// 그러면 터미널 모드 미러가 읽을 기록 파일이 안 생긴다(실제로 겪음). 사용자가 직접 정한 설정(CLAUDE_CONFIG_DIR, CLAUDE_CODE_USE_BEDROCK 등)은 남긴다.

/** 실행 중인 세션이 자식 프로세스에 심는 표식. 사용자 설정이 아니라 런타임 상태다. */
export const NESTED_SESSION_MARKERS = new Set([
  "CLAUDECODE",
  "CLAUDE_CODE_CHILD_SESSION",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_ENTRYPOINT",
  "CLAUDE_CODE_MESSAGING_SOCKET",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_BRIDGE_SESSION_ID",
  "CLAUDE_CODE_EXECPATH",
  "CLAUDE_PID",
  "CLAUDE_EFFORT",
  "CLAUDE_PLUGIN_DATA",
  "CODEX_SANDBOX",
  "CODEX_SANDBOX_NETWORK_DISABLED",
]);

export function sanitizeCliEnv(env: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (!NESTED_SESSION_MARKERS.has(k)) out[k] = v;
  return out;
}
