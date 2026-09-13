import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeUrl } from "./browser-url";

test("normalizeUrl: 포트가 붙은 호스트는 스킴이 아니라 주소로, 진짜 스킴은 막고, 공백은 검색으로", () => {
  assert.equal(normalizeUrl("localhost:3000"), "http://localhost:3000");
  assert.equal(normalizeUrl("localhost:3000/app?x=1"), "http://localhost:3000/app?x=1");
  assert.equal(normalizeUrl("127.0.0.1:8080"), "http://127.0.0.1:8080");
  assert.equal(normalizeUrl("example.com:8443/path"), "https://example.com:8443/path");
  assert.equal(normalizeUrl("localhost"), "http://localhost");
  assert.equal(normalizeUrl("example.com"), "https://example.com");
  assert.equal(normalizeUrl("http://a.b/c"), "http://a.b/c");
  assert.equal(normalizeUrl("javascript:alert(1)"), null);
  assert.equal(normalizeUrl("file:///etc/passwd"), null);
  assert.equal(normalizeUrl("mailto:a@b.c"), null);
  assert.equal(normalizeUrl("chrome://settings"), null);
  assert.equal(normalizeUrl("react hooks 사용법"), `https://duckduckgo.com/?q=${encodeURIComponent("react hooks 사용법")}`);
  assert.equal(normalizeUrl("   "), null);
});
