import { test } from "node:test";
import assert from "node:assert/strict";
import { closeEditorFile, getEditorTabs, openEditorFile, setEditorMaximized, setEditorPaneVisible } from "./editor-tabs";

test("최대화: 파일이 있어야 켜지고, 접거나 마지막 파일을 닫으면 풀린다", () => {
  const tab = "max-tab";

  // 열린 파일이 없으면 켜지지 않는다 — 넓힐 것이 없다
  setEditorMaximized(tab, true);
  assert.equal(getEditorTabs(tab).maximized, false);

  openEditorFile(tab, "/r/a.ts");
  setEditorMaximized(tab, true);
  assert.equal(getEditorTabs(tab).maximized, true);
  assert.equal(getEditorTabs(tab).visible, true, "최대화는 접힌 패널을 함께 펼친다");

  // 패널을 접으면 최대화도 푼다 — 다시 펼쳤을 때 채팅이 사라진 화면으로 돌아오면 당황스럽다
  setEditorPaneVisible(tab, false);
  assert.equal(getEditorTabs(tab).maximized, false);
  assert.equal(getEditorTabs(tab).visible, false);

  // 마지막 파일을 닫아도 풀린다
  setEditorPaneVisible(tab, true);
  setEditorMaximized(tab, true);
  assert.equal(getEditorTabs(tab).maximized, true);
  closeEditorFile(tab, "/r/a.ts");
  assert.equal(getEditorTabs(tab).files.length, 0);
  assert.equal(getEditorTabs(tab).maximized, false);
});
