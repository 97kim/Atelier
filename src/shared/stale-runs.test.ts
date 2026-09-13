import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChatEvent } from "./chat-events";
import { staleRunEvents } from "./stale-runs";

test("staleRunEvents: 진행 중으로 남은 verify/fanout/review 만 닫는 이벤트를 만든다", () => {
  const events: ChatEvent[] = [
    { type: "verify", ts: 1, runId: "v1", status: "running", cwd: "/r", head: null, commands: [{ cmd: "a", status: "passed" }, { cmd: "b", status: "running", output: "x" }, { cmd: "c", status: "pending" }] },
    { type: "verify", ts: 2, runId: "v2", status: "running", cwd: "/r", head: null, commands: [{ cmd: "a", status: "running" }] },
    { type: "verify", ts: 3, runId: "v2", status: "passed", cwd: "/r", head: null, commands: [{ cmd: "a", status: "passed" }] },
    { type: "fanout", ts: 4, fanoutId: "f1", status: "running", prompt: "p", policy: "ask", variants: [{ tabId: "t1", label: "A", provider: "claude", status: "done" }, { tabId: "t2", label: "B", provider: "codex", status: "waiting" }] },
    { type: "review", ts: 5, reviewer: "codex", reviewTabId: "rv", status: "requested", text: "" },
    { type: "review", ts: 6, reviewer: "codex", reviewTabId: "rv2", status: "done", text: "ok" },
  ];
  const out = staleRunEvents(events, 100);
  assert.deepEqual(out.map((e) => e.type), ["verify", "fanout", "review"]);
  const v = out[0];
  if (v.type !== "verify") return assert.fail("verify");
  assert.equal(v.runId, "v1");
  assert.equal(v.status, "aborted");
  assert.deepEqual(v.commands.map((c) => c.status), ["passed", "aborted", "skipped"]);
  assert.match(v.commands[1].output ?? "", /재시작/);
  const f = out[1];
  if (f.type !== "fanout") return assert.fail("fanout");
  assert.equal(f.status, "done");
  assert.deepEqual(f.variants.map((x) => x.status), ["done", "failed"]);
  const r = out[2];
  if (r.type !== "review") return assert.fail("review");
  assert.equal(r.reviewTabId, "rv");
  assert.equal(r.status, "failed");
  assert.deepEqual(staleRunEvents([]), []);
});
