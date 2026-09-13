// 검증 실행(저장한 명령을 순서대로 돌려 카드로 남기기)의 순수 부분 — 명령 목록 파싱·추천, 출력 꼬리, 요약.
// 실제 실행은 main/verify.ts, 카드는 renderer 의 VerifyCard.

import type { VerifyCommandResult } from "./chat-events";

/** 저장할 수 있는 명령 수·길이 상한. */
export const VERIFY_MAX_COMMANDS = 20;
export const VERIFY_MAX_COMMAND_LENGTH = 500;
/** 명령 하나가 카드에 남기는 출력 꼬리(문자). 그 이상은 앞을 자른다. */
export const VERIFY_OUTPUT_TAIL = 6000;
/** 명령 하나의 실행 상한. */
export const VERIFY_COMMAND_TIMEOUT_MS = 15 * 60_000;

/** 편집창 텍스트(한 줄에 명령 하나) → 명령 목록. 빈 줄·# 주석은 버리고 중복은 앞의 것만 남긴다. */
export function parseVerifyCommands(text: string): string[] {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const cmd = raw.trim();
    if (!cmd || cmd.startsWith("#")) continue;
    if (out.includes(cmd)) continue;
    out.push(cmd.slice(0, VERIFY_MAX_COMMAND_LENGTH));
    if (out.length >= VERIFY_MAX_COMMANDS) break;
  }
  return out;
}

/** 저장소를 들여다볼 최소 인터페이스(순수 테스트용). */
export interface RepoProbe {
  has(relPath: string): boolean;
  read(relPath: string): string | null;
}

/**
 * 저장한 명령이 없을 때 매니페스트에서 추천하는 명령. 흔한 순서(타입 검사 → 테스트 → 빌드)로 준다.
 * 추측이 틀려도 사용자가 편집창에서 고치므로 넓게 잡지 않는다 — 있는 스크립트만.
 */
export function suggestVerifyCommands(repo: RepoProbe): string[] {
  const out: string[] = [];
  if (repo.has("package.json")) {
    let scripts: Record<string, unknown> = {};
    try {
      const pkg = JSON.parse(repo.read("package.json") ?? "{}") as { scripts?: Record<string, unknown> };
      scripts = pkg.scripts && typeof pkg.scripts === "object" ? pkg.scripts : {};
    } catch {
      scripts = {};
    }
    const pm = repo.has("pnpm-lock.yaml") ? "pnpm" : repo.has("yarn.lock") ? "yarn" : repo.has("bun.lockb") || repo.has("bun.lock") ? "bun" : "npm";
    const run = (name: string) => (pm === "npm" ? `npm run ${name}` : `${pm} ${name}`);
    for (const name of ["typecheck", "lint", "test", "build"]) if (typeof scripts[name] === "string") out.push(run(name));
  }
  if (repo.has("gradlew")) out.push("./gradlew test");
  else if (repo.has("build.gradle") || repo.has("build.gradle.kts")) out.push("gradle test");
  else if (repo.has("mvnw")) out.push("./mvnw -q test");
  else if (repo.has("pom.xml")) out.push("mvn -q test");
  if (repo.has("Cargo.toml")) out.push("cargo test");
  if (repo.has("go.mod")) out.push("go test ./...");
  if (repo.has("pyproject.toml") || repo.has("pytest.ini") || repo.has("setup.py")) out.push("pytest");
  if (repo.has("Makefile")) {
    const mk = repo.read("Makefile") ?? "";
    if (/^test\s*:/m.test(mk) && out.length === 0) out.push("make test");
  }
  return out;
}

/** 출력 버퍼의 꼬리만 남긴다. 잘렸으면 첫 줄에 표시. */
export function tailOutput(text: string, max = VERIFY_OUTPUT_TAIL): string {
  if (text.length <= max) return text;
  const cut = text.slice(text.length - max);
  const nl = cut.indexOf("\n");
  return "…(앞부분 생략)\n" + (nl >= 0 && nl < 200 ? cut.slice(nl + 1) : cut);
}

/** 전체 결과 = 명령 결과들의 합: 하나라도 failed 면 failed, aborted 가 있으면 aborted, 다 passed 면 passed. */
export function overallStatus(commands: VerifyCommandResult[]): "running" | "passed" | "failed" | "aborted" {
  if (commands.some((c) => c.status === "failed")) return "failed";
  if (commands.some((c) => c.status === "aborted")) return "aborted";
  if (commands.some((c) => c.status === "pending" || c.status === "running")) return "running";
  return "passed";
}

export const VERIFY_STATUS_LABEL: Record<"running" | "passed" | "failed" | "aborted", string> = {
  running: "실행 중",
  passed: "통과",
  failed: "실패",
  aborted: "중단됨",
};

/** 카드 헤더 한 줄: "3개 통과" · "2번째에서 실패" 등. */
export function verifySummary(commands: VerifyCommandResult[]): string {
  const passed = commands.filter((c) => c.status === "passed").length;
  const failedIdx = commands.findIndex((c) => c.status === "failed");
  if (failedIdx >= 0) return `${failedIdx + 1}번째 명령 실패 (${passed}/${commands.length} 통과)`;
  const runningIdx = commands.findIndex((c) => c.status === "running");
  if (runningIdx >= 0) return `${runningIdx + 1}/${commands.length} 실행 중`;
  if (commands.some((c) => c.status === "aborted")) return `${passed}/${commands.length} 통과 뒤 중단`;
  return `${passed}/${commands.length} 통과`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}분 ${s % 60}초` : `${s}초`;
}

/** 실패한 명령의 출력을 채팅에 붙일 때의 제목. */
export function failedCommandTitle(c: VerifyCommandResult): string {
  return `검증 실패: ${c.cmd}${typeof c.exitCode === "number" ? ` (exit ${c.exitCode})` : ""}`;
}
