import { test } from "node:test";
import assert from "node:assert/strict";
import { isUsageLimitText, usageLimitRetryAt } from "./usage-limit";

test("isUsageLimitText: SDK 접두·usage limit·rate limit 은 참, 권한 거부는 거짓", () => {
  assert.equal(isUsageLimitText("You've hit your limit · resets 3pm"), true);
  assert.equal(isUsageLimitText("Claude AI usage limit reached|1757000000"), true);
  assert.equal(isUsageLimitText("rate_limit"), true);
  assert.equal(isUsageLimitText("API Error: 429 Too Many Requests"), true);
  assert.equal(isUsageLimitText("사용자가 이 작업을 거부했습니다."), false);
  assert.equal(isUsageLimitText("실행 중 오류로 턴이 중단되었습니다."), false);
  assert.equal(isUsageLimitText(undefined), false);
});

test("usageLimitRetryAt: rejected resetsAt 우선, 텍스트 epoch 폴백, 과거면 now+60s, 없으면 null", () => {
  const now = 1_800_000_000_000;
  assert.equal(usageLimitRetryAt("x", 1_800_003_600, now), 1_800_003_600_000);
  assert.equal(usageLimitRetryAt("Claude AI usage limit reached|1800007200", null, now), 1_800_007_200_000);
  assert.equal(usageLimitRetryAt("x", 1_700_000_000, now), now + 60_000);
  assert.equal(usageLimitRetryAt("You've hit your limit", null, now), null);
});
