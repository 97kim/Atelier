import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { DIAG_MAX_LINE, formatDiagnostics, pushCapped, type ConsoleLine, type NetFailure } from "./browser-diagnostics";

const at = Date.UTC(2026, 8, 13, 1, 2, 3);
const line = (over: Partial<ConsoleLine> = {}): ConsoleLine => ({ ts: at, level: 3, text: "boom", ...over });
const fail = (over: Partial<NetFailure> = {}): NetFailure => ({ ts: at, url: "https://x/y", method: "GET", error: null, status: 500, ...over });

describe("pushCapped", () => {
  it("상한을 넘으면 앞에서 버리고 원본은 그대로 둔다", () => {
    const a = [1, 2, 3];
    const b = pushCapped(a, 4, 3);
    assert.deepEqual(b, [2, 3, 4]);
    assert.deepEqual(a, [1, 2, 3], "원본을 바꾸면 안 된다");
    assert.deepEqual(pushCapped([], 1, 3), [1]);
  });
});

describe("formatDiagnostics", () => {
  it("오류가 없으면 '없음' 이라고 분명히 적는다 (못 본 것과 구분되게)", () => {
    const s = formatDiagnostics({ url: "https://a.b/c", at, console: [], net: [], hasScreenshot: false });
    assert.match(s, /콘솔 경고·오류 \(없음\)/);
    assert.match(s, /실패한 요청 \(없음\)/);
    assert.match(s, /https:\/\/a\.b\/c/);
    assert.doesNotMatch(s, /캡처입니다/);
  });

  it("info·log 는 빼고 warn 이상만 싣는다", () => {
    const s = formatDiagnostics({
      url: "u",
      at,
      console: [line({ level: 0, text: "verbose" }), line({ level: 1, text: "info" }), line({ level: 2, text: "careful" }), line({ level: 3, text: "boom" })],
      net: [],
      hasScreenshot: false,
    });
    assert.doesNotMatch(s, /verbose|info/);
    assert.match(s, /warn: careful/);
    assert.match(s, /error: boom/);
    assert.match(s, /콘솔 경고·오류 \(2건\)/);
  });

  it("연달아 같은 줄은 한 줄로 접고 횟수를 붙인다", () => {
    const s = formatDiagnostics({ url: "u", at, console: [line(), line(), line(), line({ text: "other" })], net: [], hasScreenshot: false });
    assert.match(s, /error: boom \(3번\)/);
    assert.match(s, /error: other/);
    assert.match(s, /콘솔 경고·오류 \(2건\)/);
  });

  it("통신 오류와 HTTP 오류를 나눠 적는다", () => {
    const s = formatDiagnostics({
      url: "u",
      at,
      console: [],
      net: [fail({ error: "net::ERR_CONNECTION_REFUSED", status: 0, url: "https://api/x" }), fail({ status: 404, url: "https://api/y", method: "POST" })],
      hasScreenshot: true,
    });
    assert.match(s, /net::ERR_CONNECTION_REFUSED — GET https:\/\/api\/x/);
    assert.match(s, /HTTP 404 — POST https:\/\/api\/y/);
    assert.match(s, /캡처입니다/);
  });

  it("긴 줄은 잘라서 길이를 적는다", () => {
    const long = "x".repeat(DIAG_MAX_LINE + 50);
    const s = formatDiagnostics({ url: "u", at, console: [line({ text: long })], net: [], hasScreenshot: false });
    assert.ok(!s.includes(long), "원문 전체가 들어가면 안 된다");
    assert.match(s, new RegExp(`\\(${DIAG_MAX_LINE + 50}자\\)`));
  });
});
