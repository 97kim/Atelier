// 끌어 옮기기의 순서 계산. 화면에서 "이 항목을 저 항목 앞/뒤로" 라는 한 가지 동작만 쓴다.
// 목록에는 다른 워크스페이스의 탭이 섞여 있을 수 있지만, 옮긴 항목을 대상 바로 옆에 두면
// 보이는 순서는 언제나 의도대로 바뀐다.

/** movedId 를 targetId 의 앞(after=false) 또는 뒤로 옮긴 새 목록. 옮길 수 없으면 원본 그대로. */
export function moveNextTo(ids: string[], movedId: string, targetId: string, after: boolean): string[] {
  if (movedId === targetId) return ids;
  if (!ids.includes(movedId) || !ids.includes(targetId)) return ids;
  const next = ids.filter((id) => id !== movedId);
  const at = next.indexOf(targetId);
  next.splice(after ? at + 1 : at, 0, movedId);
  return next;
}
