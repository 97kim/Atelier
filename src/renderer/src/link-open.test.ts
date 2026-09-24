import { test } from "node:test";
import assert from "node:assert/strict";
import { linkTargetFor } from "./link-open";

const mods = (o: Partial<{ metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; button: number }> = {}) => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  button: 0,
  ...o,
});

test("linkTargetFor: 수식키가 기억한 방식보다 앞선다", () => {
  const url = "https://example.com";
  assert.equal(linkTargetFor(url, mods(), "ask"), "ask");
  assert.equal(linkTargetFor(url, mods(), "app"), "app");
  assert.equal(linkTargetFor(url, mods(), "external"), "external");
  assert.equal(linkTargetFor(url, mods({ metaKey: true }), "app"), "external", "⌘클릭은 기본 브라우저");
  assert.equal(linkTargetFor(url, mods({ button: 1 }), "app"), "external", "가운데 클릭도");
  assert.equal(linkTargetFor(url, mods({ altKey: true }), "external"), "app", "⌥클릭은 인앱");
  assert.equal(linkTargetFor(url, mods({ shiftKey: true }), "app"), "ask", "⇧클릭은 다시 묻기");
  assert.equal(linkTargetFor("mailto:a@b.c", mods({ altKey: true }), "app"), "external", "http 가 아니면 외부로만");
});
