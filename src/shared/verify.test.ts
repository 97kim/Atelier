import { test } from "node:test";
import assert from "node:assert/strict";
import { failedCommandTitle, formatDuration, overallStatus, parseVerifyCommands, suggestVerifyCommands, tailOutput, verifySummary } from "./verify";
import { createI18n } from "@shared/i18n";

// 문구 단언은 한국어 기준이다
const t = createI18n("ko").t;

const repo = (files: Record<string, string>) => ({ has: (p: string) => p in files, read: (p: string) => files[p] ?? null });

test("parseVerifyCommands: 줄 단위, 빈 줄·주석·중복 제거", () => {
  assert.deepEqual(parseVerifyCommands("yarn typecheck\n\n# 주석\n  yarn test  \nyarn test\n"), ["yarn typecheck", "yarn test"]);
  assert.deepEqual(parseVerifyCommands(""), []);
});

test("suggestVerifyCommands: package.json 스크립트 + 패키지 매니저, 있는 스크립트만", () => {
  const pkg = JSON.stringify({ scripts: { test: "node --test", build: "vite build", typecheck: "tsc" } });
  assert.deepEqual(suggestVerifyCommands(repo({ "package.json": pkg, "yarn.lock": "" })), ["yarn typecheck", "yarn test", "yarn build"]);
  assert.deepEqual(suggestVerifyCommands(repo({ "package.json": pkg })), ["npm run typecheck", "npm run test", "npm run build"]);
  assert.deepEqual(suggestVerifyCommands(repo({ "package.json": pkg, "pnpm-lock.yaml": "" })), ["pnpm typecheck", "pnpm test", "pnpm build"]);
  assert.deepEqual(suggestVerifyCommands(repo({ "package.json": "{ broken" })), []);
});

test("suggestVerifyCommands: gradle/cargo/go/pytest/make", () => {
  assert.deepEqual(suggestVerifyCommands(repo({ gradlew: "", "build.gradle.kts": "" })), ["./gradlew test"]);
  assert.deepEqual(suggestVerifyCommands(repo({ "build.gradle": "" })), ["gradle test"]);
  assert.deepEqual(suggestVerifyCommands(repo({ "Cargo.toml": "", "go.mod": "" })), ["cargo test", "go test ./..."]);
  assert.deepEqual(suggestVerifyCommands(repo({ "pyproject.toml": "" })), ["pytest"]);
  assert.deepEqual(suggestVerifyCommands(repo({ Makefile: "test:\n\tgo test\n" })), ["make test"]);
  assert.deepEqual(suggestVerifyCommands(repo({ Makefile: "build:\n\tgo build\n" })), []);
  assert.deepEqual(suggestVerifyCommands(repo({})), []);
});

test("tailOutput: 상한을 넘으면 앞을 자르고 표시를 남긴다", () => {
  assert.equal(tailOutput("abc", 10), "abc");
  const long = Array.from({ length: 50 }, (_, i) => `line ${i}`).join("\n");
  const t = tailOutput(long, 40);
  assert.ok(t.startsWith("…(앞부분 생략)\n"));
  assert.ok(t.endsWith("line 49"));
  assert.ok(!t.includes("\nline 4\n") || t.length <= 60);
});

test("overallStatus / verifySummary", () => {
  const c = (status: "pending" | "running" | "passed" | "failed" | "skipped" | "aborted", cmd = "x") => ({ cmd, status });
  assert.equal(overallStatus([c("passed"), c("passed")]), "passed");
  assert.equal(overallStatus([c("passed"), c("failed"), c("skipped")]), "failed");
  assert.equal(overallStatus([c("passed"), c("aborted")]), "aborted");
  assert.equal(overallStatus([c("passed"), c("running"), c("pending")]), "running");
  assert.equal(verifySummary([c("passed"), c("failed"), c("skipped")], t), "2번째 명령 실패 (1/3 통과)");
  assert.equal(verifySummary([c("passed"), c("running"), c("pending")], t), "2/3 실행 중");
  assert.equal(verifySummary([c("passed"), c("passed")], t), "2/2 통과");
  assert.equal(verifySummary([c("passed"), c("aborted")], t), "1/2 통과 뒤 중단");
});

test("formatDuration / failedCommandTitle", () => {
  assert.equal(formatDuration(500, t), "500ms");
  assert.equal(formatDuration(4200, t), "4초");
  assert.equal(formatDuration(125_000, t), "2분 5초");
  assert.equal(failedCommandTitle({ cmd: "yarn test", status: "failed", exitCode: 1 }), "검증 실패: yarn test (exit 1)");
  assert.equal(failedCommandTitle({ cmd: "yarn test", status: "failed", exitCode: null }), "검증 실패: yarn test");
});
