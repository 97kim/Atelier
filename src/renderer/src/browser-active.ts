// ⌘F·⌘L·⌘R 이 브라우저로 갈지, 앱 기본 동작으로 갈지.
// ⌘F 는 대화 검색과 겹치고 ⌘R 은 창 새로고침이라 함부로 뺏으면 안 된다 — 브라우저를 실제로 보고 있을 때만 가져간다.
import { closeTarget, type CloseTargetInput } from "./close-target";

export interface BrowserActiveInput extends CloseTargetInput {
  /** 지금 활성 에디터 탭이 브라우저인가. */
  activeIsBrowser: boolean;
}

/** 지금 브라우저를 보고 있으면 true — 브라우저용 단축키를 그쪽으로 보낸다. */
export function browserHasKeys(i: BrowserActiveInput): boolean {
  return i.activeIsBrowser && closeTarget(i) === "editor";
}
