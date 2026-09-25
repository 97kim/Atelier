import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeProgressNotes, claudeShowsThinkingSummaries, codexTopLevelModel, readCliDefaultModel } from "./cli-defaults";

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

test("claudeShowsThinkingSummaries·claudeProgressNotes: 사용자 < 프로젝트 < 로컬 < 관리형, CLAUDE_CONFIG_DIR 을 따르고, 서드파티 경로면 끈다", () => {
  const home = mkdtempSync(join(tmpdir(), "wb-home-"));
  const cwd = mkdtempSync(join(tmpdir(), "wb-cwd-"));
  const managed = join(home, "managed.json");
  const env = {};
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), false, "설정이 없으면 꺼짐");
  assert.equal(claudeProgressNotes(env, home, cwd, managed), true);
  mkdirSync(join(home, ".claude"));
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ showThinkingSummaries: true }));
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), true);
  assert.equal(claudeProgressNotes(env, home, cwd, managed), false, "추론 요약이 섞이니 끈다");
  mkdirSync(join(cwd, ".claude"));
  writeFileSync(join(cwd, ".claude", "settings.local.json"), JSON.stringify({ showThinkingSummaries: false }));
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), false, "로컬이 사용자 설정을 덮는다");
  writeFileSync(managed, JSON.stringify({ showThinkingSummaries: true }));
  assert.equal(claudeShowsThinkingSummaries(env, home, cwd, managed), true, "관리형이 가장 앞선다");
  const alt = mkdtempSync(join(tmpdir(), "wb-cfg-"));
  assert.equal(claudeShowsThinkingSummaries({ CLAUDE_CONFIG_DIR: alt }, home, null, join(alt, "none.json")), false, "CLAUDE_CONFIG_DIR 이면 ~/.claude 를 보지 않는다");
  assert.equal(claudeProgressNotes({ CLAUDE_CODE_USE_BEDROCK: "1" }, alt, null, join(alt, "none.json")), false, "Bedrock 경로는 진행 설명 모드를 켜지 않는다");
  assert.equal(claudeProgressNotes({ CLAUDE_CODE_USE_VERTEX: "0" }, alt, null, join(alt, "none.json")), true, "0 은 꺼진 것");
  for (const d of [home, cwd, alt]) rmSync(d, { recursive: true, force: true });
});
