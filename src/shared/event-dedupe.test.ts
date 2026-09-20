import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import type { ChatEvent } from "./chat-events";
import { buildDedupeIndex, dropReplayedPrefix, eventKey, newDedupeIndex } from "./event-dedupe";
import { STALE_NOTE } from "./stale-runs";

const toolUse = (id: string, ts: number, partial?: boolean): ChatEvent => ({
  type: "tool_use",
  ts,
  toolUseId: id,
  name: "Bash",
  input: { command: "ls" },
  ...(partial ? { partial: true } : {}),
});
const toolResult = (id: string, ts: number, output = "ok"): ChatEvent => ({ type: "tool_result", ts, toolUseId: id, output, isError: output === STALE_NOTE });
const text = (blockId: string, ts: number): ChatEvent => ({ type: "assistant_text", ts, blockId, text: "안녕" });
const delta = (blockId: string, ts: number): ChatEvent => ({ type: "text_delta", ts, blockId, text: "안" });
const user = (t: string, ts: number): ChatEvent => ({ type: "user_message", ts, id: `u-${ts}`, text: t });
const turn = (ts: number, isError = false): ChatEvent => ({
  type: "turn_result",
  ts,
  usage: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
  contextTokens: 1,
  costUsd: 0,
  durationMs: 0,
  numTurns: 1,
  modelUsage: {},
  isError,
});
/** 한 턴: 사용자 말 → 답변 → 도구 → 결과 → 턴 결과. 기록에 남는 실제 순서다. */
const aTurn = (n: number, ts: number): ChatEvent[] => [user(`말${n}`, ts), text(`msg_${n}:0`, ts + 1), toolUse(`toolu_${n}`, ts + 2), toolResult(`toolu_${n}`, ts + 3), turn(ts + 4)];

describe("event-dedupe", () => {
  it("열쇠는 모델이 붙인 id 로만 만든다", () => {
    assert.equal(eventKey(toolUse("toolu_1", 1)), "tool:toolu_1");
    assert.equal(eventKey(toolResult("toolu_1", 1)), "result:toolu_1");
    // 사용자 말·턴 결과에는 열쇠를 만들지 않는다 — 본문이나 사용량으로 맞추면 정당한 반복까지 지운다.
    assert.equal(eventKey(user("응", 1)), null);
    assert.equal(eventKey(turn(1)), null);
    // 스트리밍 중의 partial 은 곧 완성본으로 갱신되는 것이 정상이다.
    assert.equal(eventKey(toolUse("toolu_1", 1, true)), null);
    // 재시작이 채워 넣은 가짜 결과를 열쇠로 치면 진짜 결과가 잘려 나간다.
    assert.equal(eventKey(toolResult("toolu_1", 1, STALE_NOTE)), null);
    assert.equal(eventKey(text("msg_1:0", 1)), "text:msg_1:0");
  });

  it("이미 가진 앞부분만 자르고 뒤는 순서 그대로 남긴다", () => {
    const live = [...aTurn(1, 1_000), ...aTurn(2, 2_000)];
    const reimported = [...aTurn(1, 1_006), ...aTurn(2, 2_006), ...aTurn(3, 3_000)];
    const kept = dropReplayedPrefix(buildDedupeIndex(live), reimported);
    // 되풀이된 마지막 턴을 닫는 turn_result 는 남는다 — "앞 것 뒤에 붙어 있다" 는 사실이
    // "그 결과도 이미 받았다" 는 증거는 아니라서, 지우지 않는 쪽을 골랐다.
    assert.deepEqual(kept, [reimported[9], ...aTurn(3, 3_000)]);
  });

  it("전혀 다른 세션의 기록은 통째로 들어온다", () => {
    // "그 세션의 이전 대화를 불러온다" 는 기능은 살아 있어야 한다.
    const other = aTurn(9, 50_000);
    assert.deepEqual(dropReplayedPrefix(buildDedupeIndex(aTurn(1, 1_000)), other), other);
  });

  it("자를 것이 없으면 순서도 내용도 그대로다", () => {
    // 도구 없이 텍스트만 오가는 턴. 열쇠가 하나도 없으므로 손대지 않아야 한다.
    const plain = [user("안녕", 1_000), delta("msg_1:0", 1_001), delta("msg_1:0", 1_002), turn(1_003)];
    assert.deepEqual(dropReplayedPrefix(newDedupeIndex(), plain), plain);
  });

  it("같은 도구 id 가 정상적으로 두 번 와도 사이에 낀 것을 잃지 않는다", () => {
    // Codex 는 도구 시작과 완료에 같은 id 를 쓴다. 그 사이의 승인 기록이 사라지면 안 된다.
    const incoming: ChatEvent[] = [
      toolUse("toolu_1", 1_000),
      { type: "permission_request", ts: 1_001, requestId: "r1", toolUseId: "toolu_1", tool: "Bash", input: {}, canAlwaysAllow: false },
      { type: "permission_resolved", ts: 1_002, requestId: "r1", behavior: "allow" },
      toolUse("toolu_1", 1_003),
      toolResult("toolu_1", 1_004),
    ];
    // 앞선 기록이 없으므로 아무것도 자르지 않는다.
    assert.deepEqual(dropReplayedPrefix(newDedupeIndex(), incoming), incoming);
  });

  it("새 턴이 답변 없이 실패해도 그 결과를 잃지 않는다", () => {
    const live = aTurn(1, 1_000);
    // 되풀이된 턴 뒤에, 열쇠가 하나도 없는 실패 턴이 새로 붙은 경우.
    const incoming = [...aTurn(1, 1_006), user("다시", 9_000), turn(9_100, true)];
    const kept = dropReplayedPrefix(buildDedupeIndex(live), incoming);
    assert.deepEqual(
      kept.map((e) => e.type),
      ["turn_result", "user_message", "turn_result"],
    );
    assert.equal((kept[2] as { isError: boolean }).isError, true);
  });

  it("스트리밍 조각만 받아 둔 블록도 가진 것으로 친다", () => {
    // Claude 를 앱이 직접 몰면 조각(text_delta)만 남고 완성 블록은 안 남는다. 조각을 세지 않으면
    // 기록에서 온 완성 블록이 늘 처음 보는 것이 되어 되풀이 구간에서 바로 멈춰 버린다.
    const ix = buildDedupeIndex([user("말1", 1_000), delta("msg_1:0", 1_001), delta("msg_1:0", 1_002), toolUse("toolu_1", 1_003), toolResult("toolu_1", 1_004)]);
    const incoming = [user("말1", 2_000), text("msg_1:0", 2_001), toolUse("toolu_1", 2_002), toolResult("toolu_1", 2_003), user("새 말", 3_000)];
    assert.deepEqual(dropReplayedPrefix(ix, incoming), [incoming[4]]);
  });

  it("처음 보는 답변 앞에서 멈춘다 — 뒤에 아는 도구가 있어도", () => {
    // Codex 는 완성 블록을 바로 남긴다. 못 가진 답변이 아는 도구 키 앞에 있으면 그 답변까지 잘리면 안 된다.
    const ix = buildDedupeIndex([toolUse("toolu_A", 10)]);
    const incoming = [text("msg_새:0", 20), toolUse("toolu_A", 21), toolResult("toolu_A", 22)];
    assert.deepEqual(dropReplayedPrefix(ix, incoming), incoming);
  });

  it("못 가진 것이 나오면 거기서 멈춘다 — 사이에 낀 새 결과를 잃지 않는다", () => {
    // 병렬로 띄운 도구의 시작만 받고 앱이 꺼진 뒤, 결과가 담긴 기록을 불러오는 경우.
    const ix = buildDedupeIndex([toolUse("toolu_A", 10), toolUse("toolu_B", 11)]);
    const incoming = [toolUse("toolu_A", 20), toolResult("toolu_A", 21, "A 결과"), toolUse("toolu_B", 22), toolResult("toolu_B", 23, "B 결과")];
    const kept = dropReplayedPrefix(ix, incoming);
    // A 의 결과는 아직 가진 적이 없다. B 의 시작이 뒤에 있다고 해서 함께 잘리면 안 된다.
    assert.deepEqual(kept, incoming.slice(1));
  });

  it("자를 것이 없으면 맨 앞의 턴 결과도 건드리지 않는다", () => {
    const incoming = [turn(1_000), user("안녕", 1_001)];
    assert.deepEqual(dropReplayedPrefix(newDedupeIndex(), incoming), incoming);
  });

  it("색인은 남은 것으로 갱신된다 — 같은 것이 또 와도 다시 걸린다", () => {
    const ix = newDedupeIndex();
    assert.equal(dropReplayedPrefix(ix, aTurn(1, 1_000)).length, 5);
    // 도구 호출과 결과는 잘리고 턴을 닫는 것만 남는다.
    assert.deepEqual(dropReplayedPrefix(ix, aTurn(1, 1_006)).map((e) => e.type), ["turn_result"]);
  });
});
