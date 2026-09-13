import { test } from "node:test";
import assert from "node:assert/strict";
import { closeTarget, type CloseTargetInput } from "./close-target";

const at = (over: Partial<CloseTargetInput> = {}): CloseTargetInput => ({
  editorShown: true,
  editorMaximized: false,
  focusInEditor: true,
  lastPane: "editor",
  hasEditorTab: true,
  ...over,
});

test("⌘W: 에디터를 보고 있으면 그 탭을, 아니면 채팅 세션을 닫는다", () => {
  assert.equal(closeTarget(at()), "editor", "포커스가 에디터면 에디터 탭");
  assert.equal(closeTarget(at({ focusInEditor: false, lastPane: "chat" })), "chat", "채팅을 마지막으로 썼으면 세션");

  // 패널이 접혀 있거나 열린 파일이 없으면 닫을 에디터 탭이 없다
  assert.equal(closeTarget(at({ editorShown: false })), "chat");
  assert.equal(closeTarget(at({ hasEditorTab: false })), "chat");
});

test("오른쪽 패널에서 파일을 열면 포커스는 거기 남는다 — 그래도 에디터 탭을 닫는다", () => {
  // 실제로 겪은 경우: 변경 파일 목록에서 파일을 골라 에디터가 떴는데 포커스는 그 버튼에 있었다.
  // 사용자는 코드를 보고 있는데 ⌘W 가 세션을 닫아 버렸다.
  assert.equal(closeTarget(at({ focusInEditor: false, lastPane: "editor" })), "editor");
  // 그 뒤 채팅을 건드리면 다시 세션 쪽으로 돌아온다
  assert.equal(closeTarget(at({ focusInEditor: false, lastPane: "chat" })), "chat");
  assert.equal(closeTarget(at({ editorShown: false, editorMaximized: true })), "chat", "패널이 없으면 최대화 값은 무시");
});

test("최대화 중에는 포커스와 무관하게 에디터 탭을 닫는다", () => {
  // 채팅이 화면에 없는데 세션을 닫으면 보고 있던 화면이 통째로 사라진다
  assert.equal(closeTarget(at({ editorMaximized: true, focusInEditor: false, lastPane: "chat" })), "editor");
  assert.equal(closeTarget(at({ editorMaximized: true, focusInEditor: true })), "editor");
  // 다만 닫을 탭 자체가 없으면 여전히 채팅
  assert.equal(closeTarget(at({ editorMaximized: true, hasEditorTab: false, lastPane: "editor" })), "chat");
});
