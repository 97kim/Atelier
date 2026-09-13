import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { codexTopLevelModel, readCliDefaultModel } from "./cli-defaults";

test("codexTopLevelModel: 최상위 model 만, 섹션 안의 model 은 무시", () => {
  assert.equal(codexTopLevelModel('model = "gpt-6-astra"\nmodel_reasoning_effort = "medium"\n[features]\nmodel = "x"'), "gpt-6-astra");
  assert.equal(codexTopLevelModel('[profiles.a]\nmodel = "x"'), null);
  assert.equal(codexTopLevelModel("# 없음\n"), null);
});

test("readCliDefaultModel: 설정 파일에서 읽고, 없으면 null", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-clidef-"));
  assert.equal(readCliDefaultModel("claude", home), null);
  assert.equal(readCliDefaultModel("codex", home), null);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ model: "claude-fable-5-1[1m]" }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "config.toml"), 'model = "gpt-6-astra"\n');
  assert.equal(readCliDefaultModel("claude", home), "claude-fable-5-1[1m]");
  assert.equal(readCliDefaultModel("codex", home), "gpt-6-astra");
  writeFileSync(join(home, ".claude", "settings.json"), "{broken");
  assert.equal(readCliDefaultModel("claude", home), null);
  rmSync(home, { recursive: true, force: true });
});
