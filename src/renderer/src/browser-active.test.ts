import { test } from "node:test";
import assert from "node:assert/strict";
import { browserHasKeys, type BrowserActiveInput } from "./browser-active";
import { nextZoom, viewportById, zoomLevelToPercent, VIEWPORTS } from "./browser-viewport";

const at = (over: Partial<BrowserActiveInput> = {}): BrowserActiveInput => ({
  editorShown: true,
  editorMaximized: false,
  focusInEditor: true,
  lastPane: "editor",
  hasEditorTab: true,
  activeIsBrowser: true,
  ...over,
});

test("⌘F·⌘L·⌘R 은 브라우저를 실제로 보고 있을 때만 가져간다", () => {
  assert.equal(browserHasKeys(at()), true);

  // 활성 에디터 탭이 파일이면 브라우저 단축키가 아니다 — ⌘F 는 대화 검색으로 가야 한다
  assert.equal(browserHasKeys(at({ activeIsBrowser: false })), false);
  // 채팅을 쓰고 있으면 브라우저가 열려 있어도 가져가지 않는다
  assert.equal(browserHasKeys(at({ focusInEditor: false, lastPane: "chat" })), false);
  // 패널이 접혀 있으면 볼 수 없다
  assert.equal(browserHasKeys(at({ editorShown: false })), false);
  // 넓게 보기 중이면 채팅이 화면에 없으므로 브라우저가 가져간다
  assert.equal(browserHasKeys(at({ editorMaximized: true, focusInEditor: false, lastPane: "chat" })), true);
});

test("보기 폭 프리셋", () => {
  assert.equal(viewportById("full").width, null, "전체는 폭을 제한하지 않는다");
  assert.equal(viewportById("phone").width, 390);
  assert.equal(viewportById("없는값").id, "full", "모르는 값은 전체로");
  assert.ok(VIEWPORTS.every((v) => v.id && (v.width === null || v.width > 0)), "모든 프리셋에 id 와 폭이 있다");
});

test("확대 배율: 한 칸씩 움직이고 끝에서 멈춘다", () => {
  assert.equal(zoomLevelToPercent(0), 100);
  assert.equal(zoomLevelToPercent(1), 120);
  assert.equal(zoomLevelToPercent(-1), 83);

  assert.equal(nextZoom(0, 1), 1);
  assert.equal(nextZoom(0, -1), -1);
  assert.equal(nextZoom(4, 1), 4, "맨 위에서 더 올려도 그대로");
  assert.equal(nextZoom(-3, -1), -3, "맨 아래에서 더 내려도 그대로");
  assert.equal(nextZoom(99, 1), 1, "범위 밖 값이 와도 기준(100%)에서 한 칸");
});
