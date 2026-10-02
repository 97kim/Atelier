import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { createI18n } from "./i18n";
import { clickScript, fillScript, readScript } from "./browser-control";

const { t } = createI18n("ko");

// 주입 스크립트는 문자열로 페이지에 들어간다 — 문법이 깨지면 조용히 실패한다.
// 여기서는 "파싱은 되는가" 와 "값이 코드로 새지 않는가" 를 본다.
const parses = (code: string) => {
  new vm.Script(code); // 문법 오류면 던진다
  return true;
};

test("세 스크립트 모두 문법이 맞다", () => {
  assert.ok(parses(readScript()));
  assert.ok(parses(clickScript(t, { selector: "#go" })));
  assert.ok(parses(clickScript(t, { text: "저장" })));
  assert.ok(parses(fillScript(t, "#name", "홍길동")));
});

test("따옴표·역슬래시·줄바꿈이 든 값이 코드를 깨뜨리지 않는다", () => {
  const nasty = `"); alert('xss'); //`;
  assert.ok(parses(clickScript(t, { selector: nasty })));
  assert.ok(parses(clickScript(t, { text: nasty })));
  assert.ok(parses(fillScript(t, nasty, nasty)));
  assert.ok(parses(fillScript(t, "#a", "줄1\n줄2\\끝\t")));
  // 값은 JSON 문자열로만 실려야 한다 — 코드 자리에 그대로 박히면 안 된다.
  assert.ok(fillScript(t, "#a", nasty).includes(JSON.stringify(nasty)));
  assert.ok(!fillScript(t, "#a", nasty).includes(`alert('xss'); //\n`));
});

test("</script> 가 든 값도 문자열로만 실린다", () => {
  const s = fillScript(t, "#a", "</script><img onerror=1>");
  assert.ok(parses(s));
  assert.ok(s.includes(JSON.stringify("</script><img onerror=1>")));
});

test("click 은 선택자도 글도 없으면 스스로 거절한다", () => {
  const code = clickScript(t, {});
  assert.ok(parses(code));
  // 페이지에서 실행되기 전에 문자열로도 확인할 수 있게 메시지를 담고 있다.
  assert.match(code, /--selector 나 --text/);
});

test("read 는 상한을 코드에 담는다", () => {
  const code = readScript();
  assert.match(code, /slice\(0, 20000\)/);
  assert.match(code, /out\.length >= 60/);
});

test("fill 은 네이티브 setter 를 쓴다 — React 상태가 갱신되게", () => {
  const code = fillScript(t, "#a", "v");
  assert.match(code, /getOwnPropertyDescriptor/);
  assert.match(code, /dispatchEvent\(new Event\("input"/);
  assert.match(code, /dispatchEvent\(new Event\("change"/);
});
