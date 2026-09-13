import { test } from "node:test";
import assert from "node:assert/strict";
import { buildReviewPrompt, CROSS_REVIEW_DIFF_MAX, isReadOnlyCommand, otherProvider, reviewPermissionDecision, reviewScope, reviewTabTitle } from "./cross-review";

test("cross-review: 상대 provider·제목·범위·프롬프트(긴 diff 는 자른다)", () => {
  assert.equal(otherProvider("claude"), "codex");
  assert.equal(otherProvider("codex"), "claude");
  assert.equal(reviewTabTitle("auth 버그"), "교차 리뷰 · auth 버그");
  assert.equal(reviewScope([{ path: "a", added: 40, deleted: 2 }, { path: "b", added: 2, deleted: 5 }]), "2개 파일 · +42 −7");
  const p = buildReviewPrompt({ originTitle: "auth 버그", author: "claude", changes: [{ path: "src/a.ts", kind: "modified" }], diff: "diff --git a/src/a.ts\n+x" });
  assert.match(p, /Claude Code 와 함께 작업한 "auth 버그"/);
  assert.match(p, /수정하지 마세요/);
  assert.match(p, /- src\/a\.ts \(modified\)/);
  assert.match(p, /```diff\ndiff --git a\/src\/a\.ts\n\+x\n```$/);
  const long = buildReviewPrompt({ originTitle: "t", author: "codex", changes: [], diff: "x".repeat(CROSS_REVIEW_DIFF_MAX + 10) });
  assert.match(long, /10자 생략/);
});

test("reviewPermissionDecision: 읽기 도구·읽기 명령은 allow, 수정·쓰기·알 수 없는 것은 deny", () => {
  assert.equal(reviewPermissionDecision("Read", { file_path: "/a" }), "allow");
  assert.equal(reviewPermissionDecision("Grep", {}), "allow");
  assert.equal(reviewPermissionDecision("Edit", {}), "deny");
  assert.equal(reviewPermissionDecision("ApplyPatch", {}), "deny");
  assert.equal(reviewPermissionDecision("권한", {}), "deny");
  for (const ok of ["/bin/zsh -lc 'git diff -- a.kt && nl -ba a.kt'", "git diff HEAD -- src", "rg -n 'foo' src | head -20", "cat a.ts && grep -n x b.ts", "git log --oneline -5; git status --short", "sed -n '1,20p' a.ts", "FOO=1 ls -la", "/usr/bin/grep -r x ."])
    assert.equal(reviewPermissionDecision("Bash", { command: ok }), "allow", ok);
  for (const bad of ["rm -rf x", "git commit -m x", "git branch -D x", "sed -i '' 's/a/b/' a.ts", "cat a > b", "echo $(rm x)", "cd src && ls", "yarn test", "npm install", "git remote add x y", ""])
    assert.equal(reviewPermissionDecision("Bash", { command: bad }), "deny", bad);
  assert.equal(reviewPermissionDecision("exec", { command: ["git", "diff"] }), "allow");
  // Codex 의 셸 래핑
  assert.equal(reviewPermissionDecision("Bash", { command: "/bin/zsh -lc pwd" }), "allow");
  assert.equal(reviewPermissionDecision("Bash", { command: "/bin/zsh -lc \"rg -n retry src | head\"" }), "allow");
  assert.equal(reviewPermissionDecision("Bash", { command: "bash -c 'git commit -m x'" }), "deny");
  assert.equal(reviewPermissionDecision("Bash", { command: "/bin/zsh -lc \"cat a > b\"" }), "deny");
});

test("isReadOnlyCommand: Codex 리뷰가 지적한 우회 — 줄바꿈·단독 &·래퍼·경로·쓰기 플래그", () => {
  assert.equal(isReadOnlyCommand("pwd\nrm -rf ./victim"), false);
  assert.equal(isReadOnlyCommand("pwd & rm -rf ./victim"), false);
  assert.equal(isReadOnlyCommand("env rm -rf ./victim"), false);
  assert.equal(isReadOnlyCommand("xargs rm"), false);
  assert.equal(isReadOnlyCommand("find . -delete"), false);
  assert.equal(isReadOnlyCommand("find . -name x -exec rm {} \;"), false);
  assert.equal(isReadOnlyCommand("git diff --output=./victim"), false);
  assert.equal(isReadOnlyCommand("git -c core.editor=touch diff"), false);
  assert.equal(isReadOnlyCommand("./attacker/ls"), false);
  assert.equal(isReadOnlyCommand("/usr/bin/env ls"), false);
  assert.equal(isReadOnlyCommand("sort -o out.txt in.txt"), false);
  assert.equal(isReadOnlyCommand("awk 'BEGIN{system(\"rm x\")}'"), false);
  assert.equal(isReadOnlyCommand("sed -n '1,3w out' file"), false);
  assert.equal(isReadOnlyCommand("(rm x)"), false);
  // 여전히 허용되는 읽기 명령
  assert.equal(isReadOnlyCommand("find . -name '*.ts' -type f"), true);
  assert.equal(isReadOnlyCommand("git diff HEAD -- src"), true);
  assert.equal(isReadOnlyCommand("sed -n '1,20p' src/a.ts"), true);
  assert.equal(isReadOnlyCommand("rg -n foo src | head -20"), true);
  assert.equal(isReadOnlyCommand("cat a.txt\nwc -l b.txt"), true);
  assert.equal(isReadOnlyCommand("grep -E '(foo|bar)' src/a.ts"), true, "따옴표 안 괄호는 셸 구문이 아니다");
  assert.equal(isReadOnlyCommand("echo \"$(rm x)\""), false, "큰따옴표 안 명령 치환은 확장된다");
  assert.equal(isReadOnlyCommand("/usr/bin/grep -r x ."), true);
});
