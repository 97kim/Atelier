import { test } from "node:test";
import assert from "node:assert/strict";
import { allSettled, changeStats, excerpt, fanoutSummary, fanoutTabTitle, unionPaths, validateFanoutRequest, variantLabel } from "./fanout";

test("variantLabel / fanoutTabTitle / excerpt", () => {
  assert.equal(variantLabel(0), "A");
  assert.equal(variantLabel(3), "D");
  assert.equal(fanoutTabTitle("A", "codex", null), "팬아웃 A · Codex");
  assert.equal(fanoutTabTitle("B", "claude", "새 세션"), "팬아웃 B · Claude Code");
  assert.equal(fanoutTabTitle("B", "claude", "auth 버그"), "팬아웃 B · Claude Code · auth 버그");
  assert.equal(excerpt("  a\n\n b   c ", 100), "a b c");
  assert.equal(excerpt("abcdef", 4), "abc…");
});

test("fanoutSummary / allSettled", () => {
  const v = (status: "running" | "waiting" | "done" | "failed" | "cleaned") => ({ tabId: "t", label: "A", provider: "claude" as const, status });
  assert.equal(fanoutSummary([v("done"), v("running"), v("waiting")]), "1/3 완료 · 1 응답 필요");
  assert.equal(fanoutSummary([v("done"), v("failed")]), "1/2 완료 · 1 실패");
  assert.equal(fanoutSummary([v("cleaned"), v("cleaned")]), "비교 종료");
  assert.equal(allSettled([v("done"), v("failed")]), true);
  assert.equal(allSettled([v("done"), v("waiting")]), false);
});

test("changeStats / unionPaths", () => {
  const c = (path: string, added = 1, deleted = 0) => ({ path, kind: "modified" as const, added, deleted });
  assert.deepEqual(changeStats([c("a", 3, 1), c("b", 2, 2)]), { files: 2, added: 5, deleted: 3 });
  assert.deepEqual(unionPaths([{ label: "A", changes: [c("src/b.ts"), c("src/a.ts")] }, { label: "B", changes: [c("src/a.ts"), c("README.md")] }]), [
    { path: "README.md", labels: ["B"] },
    { path: "src/a.ts", labels: ["A", "B"] },
    { path: "src/b.ts", labels: ["A"] },
  ]);
});

test("validateFanoutRequest", () => {
  assert.deepEqual(validateFanoutRequest({ prompt: " 고쳐줘 ", variants: ["claude", { provider: "codex", model: "gpt-5" }], policy: undefined }), { ok: true, prompt: "고쳐줘", variants: [{ provider: "claude" }, { provider: "codex", model: "gpt-5" }], policy: "auto_edit" });
  assert.equal(validateFanoutRequest({ prompt: "", variants: ["claude", "codex"], policy: "ask" }).ok, false);
  assert.equal(validateFanoutRequest({ prompt: "x", variants: ["claude"], policy: "ask" }).ok, false);
  assert.equal(validateFanoutRequest({ prompt: "x", variants: ["claude", "gemini"], policy: "ask" }).ok, false);
  assert.equal(validateFanoutRequest({ prompt: "x", variants: ["claude", "codex", "claude", "codex", "claude"], policy: "ask" }).ok, false);
  assert.equal(validateFanoutRequest({ prompt: "x", variants: ["claude", "codex"], policy: "yolo" }).ok, false);
});
