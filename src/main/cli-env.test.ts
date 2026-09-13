import { test } from "node:test";
import assert from "node:assert/strict";
import { sanitizeCliEnv } from "./cli-env";

test("sanitizeCliEnv: 중첩 세션 표식은 빼고 사용자 설정은 남긴다", () => {
  const out = sanitizeCliEnv({
    PATH: "/usr/bin",
    HOME: "/Users/me",
    CLAUDECODE: "1",
    CLAUDE_CODE_CHILD_SESSION: "1",
    CLAUDE_CODE_SESSION_ID: "abc",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_PID: "123",
    CODEX_SANDBOX: "seatbelt",
    CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_API_KEY: "sk",
  });
  assert.deepEqual(out, {
    PATH: "/usr/bin",
    HOME: "/Users/me",
    CLAUDE_CONFIG_DIR: "/Users/me/.claude-work",
    CLAUDE_CODE_USE_BEDROCK: "1",
    ANTHROPIC_API_KEY: "sk",
  });
});
