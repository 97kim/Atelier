import { test } from "node:test";
import assert from "node:assert/strict";
import { headerModelLabel, modelOptions } from "./models";

test("modelOptions: 기본 항목 + 목록 + 목록에 없는 현재 값은 직접 입력 줄로", () => {
  const list = [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }];
  assert.deepEqual(modelOptions(list, undefined, "claude-fable-5-1[1m]").map((o) => [o.id, o.label]), [["", "기본 (CLI 설정: claude-fable-5-1[1m])"], ["opus", "Opus"], ["sonnet", "Sonnet"]]);
  assert.deepEqual(modelOptions(list, "claude-opus-4", null).map((o) => o.id), ["", "opus", "sonnet", "claude-opus-4"]);
  assert.equal(modelOptions(list, "sonnet", null).length, 3);
  // CLI 설정에 모델이 없으면 CLI 기본(isDefault) 모델명을 기본 줄에 보여 준다
  assert.equal(modelOptions([{ id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true }, { id: "gpt-5.5", label: "GPT-5.5" }], undefined, null)[0].label, "기본 (CLI 설정: GPT-6-Astra)");
  assert.equal(modelOptions([{ id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true }], undefined, "gpt-5.5")[0].label, "기본 (CLI 설정: gpt-5.5)");
});

test("headerModelLabel: 별칭이면 같은 계열의 실제 모델 버전을 붙이고, 막 바꿔 계열이 다르면 고른 값만", () => {
  assert.equal(headerModelLabel("opus", "claude-opus-5-5"), "Opus 5.5");
  assert.equal(headerModelLabel("opus[1m]", "claude-opus-5-5"), "Opus 5.5 (1M)");
  assert.equal(headerModelLabel("fable", "claude-fable-5-1"), "Fable 5.1");
  assert.equal(headerModelLabel("sonnet", "claude-opus-5-5"), "sonnet", "sonnet 으로 바꾼 직후엔 옛 opus 버전을 붙이지 않는다");
  assert.equal(headerModelLabel("claude-opus-5", "claude-opus-5"), "Opus 5");
  assert.equal(headerModelLabel("", "claude-opus-5-5"), "Opus 5.5", "기본 모델이면 실제 모델");
  assert.equal(headerModelLabel("gpt-6-astra", "gpt-6-astra"), "gpt-6-astra", "가격표에 없는 모델은 id 그대로");
  assert.equal(headerModelLabel("opus", null), "opus");
  assert.equal(headerModelLabel(null, null), "");
});
