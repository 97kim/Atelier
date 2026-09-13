import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { permissionResultFor } from "./claude-adapter";

const q = { questions: [{ question: "어느 쪽?", header: "방향", options: [{ label: "A", description: "" }, { label: "B", description: "" }] }] };

describe("permissionResultFor", () => {
  it("일반 도구: 허용은 입력 그대로, always 면 제안 규칙을 싣는다", () => {
    const sug = [{ type: "addRules", rules: [], behavior: "allow", destination: "session" }] as never;
    assert.deepEqual(permissionResultFor("Bash", { command: "ls" }, { behavior: "allow" }, sug), { behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: undefined });
    assert.deepEqual(permissionResultFor("Bash", { command: "ls" }, { behavior: "allow", always: true }, sug), { behavior: "allow", updatedInput: { command: "ls" }, updatedPermissions: sug });
    assert.equal(permissionResultFor("Bash", { command: "ls" }, { behavior: "deny" }).behavior, "deny");
  });

  it("AskUserQuestion: 답이 있으면 updatedInput.answers 로 돌려준다", () => {
    const r = permissionResultFor("AskUserQuestion", q, { behavior: "allow", answers: { "어느 쪽?": "B" } });
    assert.equal(r.behavior, "allow");
    assert.deepEqual((r as { updatedInput: unknown }).updatedInput, { ...q, answers: { "어느 쪽?": "B" } });
  });

  it("AskUserQuestion: 답 없는 허용·거부는 모두 deny (빈 답으로 진행되지 않게)", () => {
    for (const a of [{ behavior: "allow" as const }, { behavior: "allow" as const, answers: {} }, { behavior: "deny" as const }]) {
      const r = permissionResultFor("AskUserQuestion", q, a);
      assert.equal(r.behavior, "deny");
      assert.equal((r as { interrupt?: boolean }).interrupt, false);
    }
  });
});
