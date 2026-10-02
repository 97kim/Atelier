import { test } from "node:test";
import assert from "node:assert/strict";
import { createI18n } from "./i18n";
import { PICKER_STOP_SCRIPT, PICK_CANCEL_MARK, PICK_MARK, elementImage, formatElementAttachment, parsePickMessage, pickerScript } from "./element-pick";
const PICKER_SCRIPT = pickerScript("n1");

test("PICKER_SCRIPT 는 문법상 올바른 JS 다", () => {
  assert.doesNotThrow(() => new Function(PICKER_SCRIPT));
  assert.doesNotThrow(() => new Function(PICKER_STOP_SCRIPT));
  assert.ok(PICKER_SCRIPT.includes(PICK_MARK));
  assert.ok(PICKER_SCRIPT.includes('"n1"'));
  assert.ok(!PICKER_SCRIPT.includes("__NONCE__"));
});

test("parsePickMessage: 마커·취소·무관", () => {
  const el = { selector: "main > h1", tag: "h1", html: "<h1>v2</h1>", text: "v2", styles: { "font-size": "32px" }, rect: { x: 8, y: 21.4, width: 100, height: 37 }, dpr: 2 };
  assert.deepEqual(parsePickMessage(PICK_MARK + "n1:" + JSON.stringify(el), "n1"), { kind: "picked", element: el });
  assert.equal(parsePickMessage(PICK_MARK + "other:" + JSON.stringify(el), "n1"), null, "nonce 가 다르면 무관");
  assert.equal(parsePickMessage(PICK_MARK + JSON.stringify(el), "n1"), null, "nonce 없는 옛 형식도 무관");
  assert.deepEqual(parsePickMessage(PICK_CANCEL_MARK, "n1"), { kind: "cancel" });
  assert.equal(parsePickMessage("hello", "n1"), null);
  assert.equal(parsePickMessage(PICK_MARK + "n1:{broken", "n1"), null);
  assert.equal(parsePickMessage(PICK_MARK + "n1:" + JSON.stringify({ selector: "x" }), "n1"), null);
  // 상한: 긴 html 은 잘리고, 무한대 좌표는 상한으로, 이상한 스타일 키는 버린다
  const big = parsePickMessage(PICK_MARK + "n1:" + JSON.stringify({ ...el, html: "x".repeat(10_000), rect: { x: Infinity, y: -1e9, width: 1e9, height: NaN }, styles: { "font-size": "1px", "<bad>": "y", ok: 5 } }), "n1");
  assert.equal(big?.kind, "picked");
  if (big?.kind !== "picked") return;
  assert.equal(big.element.html.length, 4001);
  assert.deepEqual(big.element.rect, { x: 0, y: -20000, width: 20000, height: 0 });
  assert.deepEqual(big.element.styles, { "font-size": "1px" });
});

test("formatElementAttachment / elementImage", () => {
  const el = { selector: "main > h1", tag: "h1", html: "<h1>v2</h1>", text: "v2", styles: { "font-size": "32px", color: "rgb(0, 0, 0)" }, rect: { x: 8, y: 21.4, width: 100.2, height: 37 }, dpr: 2 };
  assert.equal(
    formatElementAttachment(createI18n("ko").t, el, "http://127.0.0.1:5000/p/x/index.html"),
    "브라우저 요소 · http://127.0.0.1:5000/p/x/index.html\n선택자: main > h1\n텍스트: v2\n```html\n<h1>v2</h1>\n```\n계산된 스타일: font-size: 32px; color: rgb(0, 0, 0)\n크기: 100×37 @ (8, 21)",
  );
  assert.deepEqual(elementImage("data:image/png;base64,AAAA", el), { name: "element-h1.png", mime: "image/png", base64: "AAAA" });
  assert.equal(elementImage("", el), null);
});

test("주입 스크립트의 tidy: 소수 둘째 자리 이상 px 는 한 자리로 반올림", () => {
  const start = PICKER_SCRIPT.indexOf("const tidy");
  const stmt = PICKER_SCRIPT.slice(start, PICKER_SCRIPT.indexOf(";", start) + 1);
  const fn = new Function(stmt + " return tidy('63.9141px 8px 1.5px');") as () => string;
  assert.equal(fn(), "63.9px 8px 1.5px");
});
