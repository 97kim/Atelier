// 두 AI SDK 는 ESM 전용인데 main 은 CJS 로 번들된다. 번들러가 import() 를 require 로
// 바꾸면 ERR_REQUIRE_ESM 이 나므로 Function 생성자로 진짜 dynamic import 를 보존한다.
// (electron.vite.config.ts 의 externalizeDepsPlugin 과 한 쌍)
const importEsm = new Function("specifier", "return import(specifier)") as <T>(
  specifier: string,
) => Promise<T>;

type ClaudeSdk = typeof import("@anthropic-ai/claude-agent-sdk");
type CodexSdk = typeof import("@openai/codex-sdk");

let claudeSdk: Promise<ClaudeSdk> | null = null;
let codexSdk: Promise<CodexSdk> | null = null;

export function importClaudeSdk(): Promise<ClaudeSdk> {
  claudeSdk ??= importEsm<ClaudeSdk>("@anthropic-ai/claude-agent-sdk");
  return claudeSdk;
}

export function importCodexSdk(): Promise<CodexSdk> {
  codexSdk ??= importEsm<CodexSdk>("@openai/codex-sdk");
  return codexSdk;
}
