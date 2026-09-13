import { test } from "node:test";
import assert from "node:assert/strict";
import { modelOptions } from "./models";

test("modelOptions: 기본 항목 + 목록 + 목록에 없는 현재 값은 직접 입력 줄로", () => {
  const list = [{ id: "opus", label: "Opus" }, { id: "sonnet", label: "Sonnet" }];
  assert.deepEqual(modelOptions(list, undefined, "claude-fable-5-1[1m]").map((o) => [o.id, o.label]), [["", "기본 (CLI 설정: claude-fable-5-1[1m])"], ["opus", "Opus"], ["sonnet", "Sonnet"]]);
  assert.deepEqual(modelOptions(list, "claude-opus-4", null).map((o) => o.id), ["", "opus", "sonnet", "claude-opus-4"]);
  assert.equal(modelOptions(list, "sonnet", null).length, 3);
  // CLI 설정에 모델이 없으면 CLI 기본(isDefault) 모델명을 기본 줄에 보여 준다
  assert.equal(modelOptions([{ id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true }, { id: "gpt-5.5", label: "GPT-5.5" }], undefined, null)[0].label, "기본 (CLI 설정: GPT-6-Astra)");
  assert.equal(modelOptions([{ id: "gpt-6-astra", label: "GPT-6-Astra", isDefault: true }], undefined, "gpt-5.5")[0].label, "기본 (CLI 설정: gpt-5.5)");
});
