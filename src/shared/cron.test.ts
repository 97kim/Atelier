import test from "node:test";
import assert from "node:assert/strict";
import { classify, matches, nextOccurrence, parseCron, presetToCron, wallClock } from "@shared/cron";

const KST = "Asia/Seoul";
const NY = "America/New_York";
const at = (iso: string) => Date.parse(iso);
const inTz = (ms: number, tz: string) => {
  const w = wallClock(ms, tz);
  return `${w.year}-${String(w.month).padStart(2, "0")}-${String(w.day).padStart(2, "0")} ${String(w.hour).padStart(2, "0")}:${String(w.minute).padStart(2, "0")}`;
};
const next = (expr: string, from: string, tz = KST) => {
  const c = parseCron(expr);
  assert.ok(c, `못 읽은 cron: ${expr}`);
  const t = nextOccurrence(c, at(from), tz);
  return t === null ? null : inTz(t, tz);
};

test("형식이 틀린 것은 읽지 않는다", () => {
  for (const bad of ["", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "abc * * * *", "5-1 * * * *", "*/0 * * * *"]) {
    assert.equal(parseCron(bad), null, bad);
  }
});

test("매일 09:30 — 시간대는 일정에 저장한 것을 쓴다", () => {
  assert.equal(next("30 9 * * *", "2026-09-19T00:00:00+09:00"), "2026-09-19 09:30");
  assert.equal(next("30 9 * * *", "2026-09-19T09:30:00+09:00"), "2026-09-20 09:30", "같은 분은 다시 잡지 않는다");
  // 같은 cron 이라도 시간대가 다르면 다른 순간이다
  const kst = nextOccurrence(parseCron("30 9 * * *")!, at("2026-09-19T00:00:00Z"), KST);
  const ny = nextOccurrence(parseCron("30 9 * * *")!, at("2026-09-19T00:00:00Z"), NY);
  assert.notEqual(kst, ny);
});

test("평일·주간·매시", () => {
  // 2026-09-19 는 토요일 → 다음 평일은 월요일
  assert.equal(next("0 18 * * 1-5", "2026-09-19T00:00:00+09:00"), "2026-09-21 18:00");
  assert.equal(next("0 10 * * 1", "2026-09-19T00:00:00+09:00"), "2026-09-21 10:00");
  assert.equal(next("15 * * * *", "2026-09-19T09:20:00+09:00"), "2026-09-19 10:15");
});

test("일·요일이 둘 다 지정되면 둘 중 하나(cron 관례)", () => {
  // 매월 1일 또는 매주 월요일
  assert.equal(next("0 9 1 * 1", "2026-09-19T00:00:00+09:00"), "2026-09-21 09:00");
  assert.equal(next("0 9 1 * 1", "2026-09-22T00:00:00+09:00"), "2026-09-28 09:00");
});

test("서머타임: 사라진 시각은 그날 일어나지 않는다", () => {
  // 뉴욕 2026-03-08 02:30 은 존재하지 않는다(01:59 → 03:00)
  assert.equal(next("30 2 * * *", "2026-03-08T00:00:00-05:00", NY), "2026-03-09 02:30");
});

test("서머타임: 두 번 오는 시각도 그 날짜에는 한 번만", () => {
  // 뉴욕 2026-11-01 01:30 은 두 번 온다
  const first = nextOccurrence(parseCron("30 1 * * *")!, at("2026-11-01T00:00:00-04:00"), NY);
  assert.ok(first);
  assert.equal(inTz(first, NY), "2026-11-01 01:30");
  const after = nextOccurrence(parseCron("30 1 * * *")!, first, NY);
  assert.ok(after);
  assert.equal(inTz(after, NY), "2026-11-02 01:30", "같은 날 두 번 잡지 않는다");
});

test("일어나지 않는 일정은 null", () => {
  assert.equal(next("0 0 30 2 *", "2026-01-01T00:00:00+09:00"), null, "2월 30일");
});

test("프리셋은 cron 을 되읽어 붙이는 이름이다", () => {
  assert.deepEqual(classify("15 * * * *"), { kind: "hourly", minute: 15 });
  assert.deepEqual(classify("30 9 * * *"), { kind: "daily", hour: 9, minute: 30 });
  assert.deepEqual(classify("0 18 * * 1-5"), { kind: "weekdays", hour: 18, minute: 0 });
  assert.deepEqual(classify("0 10 * * 1"), { kind: "weekly", hour: 10, minute: 0, dayOfWeek: 1 });
  assert.deepEqual(classify("*/15 9-18 * * 1-5"), { kind: "custom" });
  assert.deepEqual(classify("0 9 1,15 * *"), { kind: "custom" });
  assert.deepEqual(classify("영 시"), { kind: "invalid" });
});

test("프리셋 → cron → 프리셋 왕복", () => {
  for (const p of [
    { kind: "hourly", minute: 5 } as const,
    { kind: "daily", hour: 7, minute: 0 } as const,
    { kind: "weekdays", hour: 18, minute: 30 } as const,
    { kind: "weekly", hour: 10, minute: 0, dayOfWeek: 3 } as const,
  ]) {
    assert.deepEqual(classify(presetToCron(p)), p);
  }
});

test("이름으로 쓴 요일·월도 읽는다", () => {
  const c = parseCron("0 9 * jan-feb mon");
  assert.ok(c);
  assert.equal(matches(c, wallClock(at("2026-01-05T09:00:00+09:00"), KST)), true);
  assert.equal(matches(c, wallClock(at("2026-03-02T09:00:00+09:00"), KST)), false, "3월은 아니다");
});
