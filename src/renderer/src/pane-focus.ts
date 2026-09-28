// 분할 화면에서 "지금 포커스된 칸" 안에 있는가. 창 전체에 거는 키·명령 리스너(승인 창의 Enter/Esc, 브라우저 명령)가
// 두 칸에서 같이 반응하지 않게 한다. 칸 wrapper 는 App 이 data-chat-pane / data-focused 로 표시한다.
// 분할이 아니거나 칸 밖(모달 등)이면 true — 지금까지처럼 동작한다.
export function inFocusedPane(el: Element | null | undefined): boolean {
  const pane = el?.closest?.("[data-chat-pane]");
  return !pane || pane.getAttribute("data-focused") === "true";
}
