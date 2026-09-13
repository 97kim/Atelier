import { test } from "node:test";
import assert from "node:assert/strict";
import { closeTarget, type CloseTargetInput } from "./close-target";

const at = (over: Partial<CloseTargetInput> = {}): CloseTargetInput => ({
  editorShown: true,
  editorMaximized: false,
  focusInEditor: true,
  hasEditorTab: true,
  ...over,
});

test("⌘W: 에디터를 보고 있으면 그 탭을, 아니면 채팅 세션을 닫는다", () => {
  assert.equal(closeTarget(at()), "editor", "포커스가 에디터면 에디터 탭");
  assert.equal(closeTarget(at({ focusInEditor: false })), "chat", "채팅에 포커스가 있으면 세션");

  // 패널이 접혀 있거나 열린 파일이 없으면 닫을 에디터 탭이 없다
  assert.equal(closeTarget(at({ editorShown: false })), "chat");
  assert.equal(closeTarget(at({ hasEditorTab: false })), "chat");
  assert.equal(closeTarget(at({ editorShown: false, editorMaximized: true })), "chat", "패널이 없으면 최대화 값은 무시");
});

test("최대화 중에는 포커스와 무관하게 에디터 탭을 닫는다", () => {
  // 채팅이 화면에 없는데 세션을 닫으면 보고 있던 화면이 통째로 사라진다
  assert.equal(closeTarget(at({ editorMaximized: true, focusInEditor: false })), "editor");
  assert.equal(closeTarget(at({ editorMaximized: true, focusInEditor: true })), "editor");
  // 다만 닫을 탭 자체가 없으면 여전히 채팅
  assert.equal(closeTarget(at({ editorMaximized: true, hasEditorTab: false })), "chat");
});
