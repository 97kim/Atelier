import { test } from "node:test";
import assert from "node:assert/strict";
import { FAVICON_MAX_BYTES, isFetchableFavicon } from "./browser-favicon";

test("파비콘 주소는 http(s) 만 받는다", () => {
  assert.equal(isFetchableFavicon("https://a.com/favicon.ico"), true);
  assert.equal(isFetchableFavicon("http://127.0.0.1:3000/favicon.png"), true);
  // 이 경로로 받을 이유가 없는 것들 — 화면에서 쓰지 않거나 위험하다.
  assert.equal(isFetchableFavicon("file:///etc/passwd"), false);
  assert.equal(isFetchableFavicon("data:image/png;base64,AAAA"), false);
  assert.equal(isFetchableFavicon("javascript:alert(1)"), false);
  assert.equal(isFetchableFavicon("chrome://favicon/x"), false);
  assert.equal(isFetchableFavicon(""), false);
  assert.equal(isFetchableFavicon("주소아님"), false);
});

test("상한은 아이콘에 맞는 크기다", () => {
  // 파비콘이 128KB 를 넘으면 아이콘이 아니다 — 화면에 그대로 실어 나르는 값이라 상한을 둔다.
  assert.equal(FAVICON_MAX_BYTES, 128 * 1024);
});
