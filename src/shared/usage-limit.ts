// 구독 사용 한도 도달 판정과 재시도 시각 계산. Claude Code 가 한도에 걸리면 result/assistant 오류 텍스트가
// SDK 의 USAGE_LIMIT_ERROR_PREFIXES 중 하나로 시작하거나 "usage limit reached|<epoch>" 꼴이고,
// rate_limit_event 는 status "rejected" 와 resetsAt 을 준다. 순수 함수만.

const PREFIXES = [
  "You've hit your",
  "You've reached your",
  "You're out of usage",
  "Your org is out of usage",
  "Your seat type doesn't include",
  "Your usage allocation has been disabled",
  "Your group's usage limit",
  "Fable 5 requires usage credits",
  "You're out of extra usage",
  "Claude AI usage limit reached",
];

export function isUsageLimitText(text: string | undefined | null): boolean {
  if (!text) return false;
  const t = text.trim();
  if (PREFIXES.some((p) => t.startsWith(p))) return true;
  return /\b(rate[_ ]limit(ed)?|usage limit|429)\b/i.test(t) && !/permission|denied/i.test(t);
}

/**
 * 재시도 시각(ms). rate_limit_event 의 resetsAt(초)을 우선, 없으면 오류 텍스트 끝의 "|<epoch 초>". 둘 다 없으면 null.
 * 과거 시각이면 지금 + 60초로 본다(시계 차이 대비).
 */
export function usageLimitRetryAt(
  text: string | undefined | null,
  rejectedResetsAtSec: number | null | undefined,
  now: number,
): number | null {
  let sec: number | null = typeof rejectedResetsAtSec === "number" && rejectedResetsAtSec > 0 ? rejectedResetsAtSec : null;
  if (sec === null && text) {
    const m = text.match(/\|(\d{9,11})\s*$/);
    if (m) sec = Number(m[1]);
  }
  if (sec === null) return null;
  const ms = sec > 1e12 ? sec : sec * 1000;
  return Math.max(ms, now + 60_000);
}

/** 재시도 상한: 리셋 뒤에도 계속 거절되면(주간 한도 등) 무한 반복하지 않는다. */
export const USAGE_LIMIT_MAX_RETRIES = 3;
