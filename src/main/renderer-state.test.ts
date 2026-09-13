import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RendererState, RENDERER_STATE_VALUE_MAX } from "./renderer-state";

test("RendererState: set 은 바로 파일에 쓰고, null 은 지우며, 새 인스턴스가 그대로 읽는다", () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-rstate-"));
  const s = new RendererState(dir);
  assert.deepEqual(s.load(), {});
  s.set("editorTabs", '{"a":1}');
  s.set("composerDraft.t1", "쓰다 만 글");
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "renderer-state.json"), "utf8")), { editorTabs: '{"a":1}', "composerDraft.t1": "쓰다 만 글" });
  s.set("composerDraft.t1", null);
  s.set("", "x"); // 잘못된 키는 무시
  s.set("big", "x".repeat(RENDERER_STATE_VALUE_MAX + 1)); // 너무 큰 값은 무시
  assert.deepEqual(new RendererState(dir).load(), { editorTabs: '{"a":1}' });
  // 깨진 파일은 빈 상태로
  writeFileSync(join(dir, "renderer-state.json"), "{broken");
  assert.deepEqual(new RendererState(dir).load(), {});
  rmSync(dir, { recursive: true, force: true });
});
