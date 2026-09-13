import { test } from "node:test";
import assert from "node:assert/strict";
import { modelFromArg, parseAppCommand, withAppCommands } from "./app-commands";

test("parseAppCommand: 이름·인자 분리, 다른 입력은 null", () => {
  assert.deepEqual(parseAppCommand("/model"), { name: "model", arg: "" });
  assert.deepEqual(parseAppCommand("  /model   opus  "), { name: "model", arg: "opus" });
  assert.deepEqual(parseAppCommand("/config"), { name: "config", arg: "" });
  assert.deepEqual(parseAppCommand("/mcp"), { name: "mcp", arg: "" });
  assert.equal(parseAppCommand("/models"), null);
  assert.equal(parseAppCommand("/modelx opus"), null);
  assert.equal(parseAppCommand("모델 바꿔 /model"), null);
  assert.equal(parseAppCommand("/compact"), null);
});

test("withAppCommands: 앱 커맨드가 앞에, CLI 의 같은 이름은 대체", () => {
  const out = withAppCommands([
    { name: "model", description: "cli", argumentHint: "" },
    { name: "compact", description: "c", argumentHint: "" },
  ]);
  assert.deepEqual(out.map((c) => c.name), ["model", "config", "mcp", "compact"]);
  assert.match(out[0].description, /앱에서 처리/);
});

test("modelFromArg: 기본값 표현은 빈 문자열, 첫 토큰만", () => {
  assert.equal(modelFromArg(""), "");
  assert.equal(modelFromArg("기본"), "");
  assert.equal(modelFromArg("Default"), "");
  assert.equal(modelFromArg("opus 뭐시기"), "opus");
  assert.equal(modelFromArg("claude-sonnet-5"), "claude-sonnet-5");
});
