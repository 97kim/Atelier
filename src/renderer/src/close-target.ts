// ⌘W 가 무엇을 닫을지 — 채팅 세션이냐, 에디터/브라우저 탭이냐.
// 사용자가 코드나 웹페이지를 보고 있는데 세션이 통째로 닫히면 놀란다.

export interface CloseTargetInput {
  /** 에디터 패널이 떠 있는가. */
  editorShown: boolean;
  /** 최대화 중인가 — 채팅이 화면에 없으므로 세션을 닫을 이유가 없다. */
  editorMaximized: boolean;
  /** 지금 포커스가 에디터 패널 안에 있는가(CodeMirror·브라우저 webview·도구막대). */
  focusInEditor: boolean;
  /** 닫을 에디터 탭이 있는가. */
  hasEditorTab: boolean;
}

/**
 * 에디터 쪽을 닫아야 하면 "editor", 아니면 "chat".
 * 최대화 중이면 포커스를 따지지 않는다 — 채팅이 안 보이는데 그걸 닫으면 화면이 통째로 사라진다.
 */
export function closeTarget(i: CloseTargetInput): "editor" | "chat" {
  if (!i.editorShown || !i.hasEditorTab) return "chat";
  if (i.editorMaximized) return "editor";
  return i.focusInEditor ? "editor" : "chat";
}
