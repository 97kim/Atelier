// 기록을 통째로 불러올 때, 이미 가진 앞부분을 잘라 낸다. 순수 — 저장·감시는 main 이 맡는다.
//
// 왜 필요한가. 훅이 다른 세션 id 를 알리면 그 세션의 기록 파일을 통째로 읽어 탭 기록에 덧붙인다.
// 그런데 재개처럼 "같은 대화인데 id 만 새로 붙은" 경우가 있어, 이미 가진 대화가 한 벌 더 쌓인다.
// 화면은 기록을 재생해 만들어지므로 사용자 말풍선만 두 번 나오고 답변은 한 번뿐인 꼴이 되어,
// "대화가 복구되지 않았다" 로 보인다(실측: 재기록 구간 5,881줄, 열쇠 있는 3,414건 중 2,178건이 중복).
//
// 어떻게 자르나. 이벤트를 하나씩 골라내지 않는다. 되풀이는 **앞에서부터 이어지는 한 덩어리**로 들어오므로,
// 이미 가진 것이 마지막으로 나타나는 자리를 찾아 거기까지만 버리고 뒤는 순서 그대로 받는다.
// 골라내는 방식은 시도해 봤다가 접었다: 열쇠 없는 이벤트(사용자 말·턴 결과·승인 기록)를 주변 열쇠에
// 묶어 판정하게 되는데, 같은 도구 id 가 정상적으로 두 번 오는 경우(Codex 는 시작·완료에 같은 id 를 쓴다)나
// 텍스트만 오가는 턴에서 엉뚱한 것이 딸려 나갔다. 자르기는 순서를 건드리지 않고 경계도 하나뿐이다.
//
// 열쇠는 모델이 붙인 id 다. toolUseId·blockId 는 기록 파일이 새로 만들어져도 그대로다. 반면 기록 파일의
// uuid 는 파일마다 새로 매겨져 재개 뒤에는 짝이 맞지 않는다 — 두 기록을 대조해 확인했다(일치 0건).

import type { ChatEvent } from "./chat-events";
import { STALE_NOTE } from "./stale-runs";

export interface DedupeIndex {
  keys: Set<string>;
}

export function newDedupeIndex(): DedupeIndex {
  return { keys: new Set() };
}

/**
 * 재시작 때 "추적이 끊겼다" 고 채워 넣은 가짜 결과. 자리를 채우는 표시일 뿐이라 열쇠로 치지 않는다 —
 * 치면 나중에 도착한 진짜 결과가 같은 id 라는 이유로 잘려 나간다.
 */
function isStalePlaceholder(e: ChatEvent): boolean {
  return e.type === "tool_result" && e.isError && e.output === STALE_NOTE;
}

/**
 * 자를 자리를 정하는 열쇠. 모델이 붙인 id 를 그대로 쓴다 — 기록 파일이 새로 만들어져도 같은 값이라
 * "이건 내가 이미 가진 그것" 이라고 말할 수 있는 유일한 증거다.
 */
export function eventKey(e: ChatEvent): string | null {
  switch (e.type) {
    case "tool_use":
      // 스트리밍 중의 partial 은 곧 완성본으로 갱신되는 것이 정상이다. 완성본만 센다.
      return e.partial ? null : `tool:${e.toolUseId}`;
    case "tool_result":
      return isStalePlaceholder(e) ? null : `result:${e.toolUseId}`;
    case "assistant_text":
      return e.blockId ? `text:${e.blockId}` : null;
    default:
      return null;
  }
}

/**
 * 색인에 넣을 열쇠. 자를 자리를 정하는 열쇠에 더해, 스트리밍 조각도 "그 블록은 이미 가졌다" 는
 * 표시로 넣는다.
 *
 * 왜 필요한가. Claude 를 앱이 직접 몰 때는 조각(text_delta)만 남고 완성 블록은 안 남는다. 조각을
 * 세지 않으면 기록에서 옮겨 온 완성 블록이 **늘** 처음 보는 것이 되어, 되풀이 구간 한가운데서 멈춰
 * 아무것도 자르지 못한다. 다행히 조각과 완성 블록은 같은 blockId 를 쓴다(실측: 완성 블록의 96.5%가
 * 조각으로도 본 것). Codex 는 완성 블록을 바로 남기므로 이쪽은 원래부터 짝이 맞는다.
 */
function indexKey(e: ChatEvent): string | null {
  if (e.type === "text_delta") return e.blockId ? `text:${e.blockId}` : null;
  return eventKey(e);
}

export function indexEvent(ix: DedupeIndex, e: ChatEvent): void {
  const key = indexKey(e);
  if (key) ix.keys.add(key);
}

export function buildDedupeIndex(events: readonly ChatEvent[]): DedupeIndex {
  const ix = newDedupeIndex();
  for (const e of events) indexEvent(ix, e);
  return ix;
}

/**
 * 이미 가진 것을 되풀이하는 앞부분을 뺀 나머지. 순서는 그대로다.
 *
 * 자르는 자리는 "앞에서부터 이어지는, 내가 이미 가진 것들" 이 끝나는 곳이다. 못 가진 것이
 * 하나라도 나오면 거기서 멈춘다 — 더 가면 그 새 이벤트까지 잘린다. 겹치는 것이 하나도 없으면
 * 아무것도 자르지 않는다(전혀 다른 세션의 기록을 불러오는 경우이고, 그건 의도된 기능이다).
 *
 * 되풀이된 마지막 턴의 `turn_result` 가 하나 남을 수 있다. 그건 그냥 둔다 — "앞 것 뒤에 붙어 있다" 는
 * 사실은 "그 결과도 이미 받았다" 는 증거가 아니다. 토큰 표시가 한 번 더해지는 것이, 받은 적 없는
 * 턴 결과를 지우는 것보다 낫다.
 *
 * `ix` 는 남은 것으로 갱신된다.
 */
export function dropReplayedPrefix(ix: DedupeIndex, events: readonly ChatEvent[]): ChatEvent[] {
  let cut = 0;
  for (let i = 0; i < events.length; i += 1) {
    const key = eventKey(events[i]);
    if (!key) continue;
    // 못 가진 것이 하나라도 나오면 거기서 멈춘다. 그 뒤에 아는 것이 또 있다고 해서 더 자르면,
    // 사이에 낀 이 새 이벤트까지 함께 잘린다(병렬 도구에서 실제로 그렇게 된다).
    if (!ix.keys.has(key)) break;
    cut = i + 1;
  }
  const rest = events.slice(cut);
  for (const e of rest) indexEvent(ix, e);
  return rest;
}
