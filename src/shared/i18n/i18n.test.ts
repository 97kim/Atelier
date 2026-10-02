import test from "node:test";
import assert from "node:assert/strict";
import { createI18n, intlLocale, isLanguageSetting, resolveLocale } from "./index";
import { en } from "./en";
import { ko } from "./ko";
import { msgText, type Msg } from "./msg";

test("system 은 시스템이 가장 선호하는 언어가 한국어일 때만 ko", () => {
  assert.equal(resolveLocale("system", ["ko-KR", "en-US"]), "ko");
  assert.equal(resolveLocale("system", ["ko"]), "ko");
  assert.equal(resolveLocale("system", ["en-US", "ko-KR"]), "en");
  assert.equal(resolveLocale("system", ["ja-JP"]), "en");
  assert.equal(resolveLocale("system", []), "en");
  // "kok"(콘칸어) 같은 다른 언어를 한국어로 잡지 않는다
  assert.equal(resolveLocale("system", ["kok-IN"]), "en");
});

test("언어를 직접 고르면 시스템 언어와 무관하다", () => {
  assert.equal(resolveLocale("en", ["ko-KR"]), "en");
  assert.equal(resolveLocale("ko", ["en-US"]), "ko");
  assert.equal(isLanguageSetting("system"), true);
  assert.equal(isLanguageSetting("ja"), false);
  assert.equal(intlLocale("ko"), "ko-KR");
  assert.equal(intlLocale("en"), "en-US");
});

test("언어별로 번역하고, 바꾸면 바로 반영된다", async () => {
  const i18n = createI18n("ko");
  assert.equal(i18n.t("toolCard.state.done"), "완료");
  await i18n.changeLanguage("en");
  assert.equal(i18n.t("toolCard.state.done"), "Done");
  // 인스턴스는 서로 독립이다(main 과 renderer 가 각자 하나씩)
  assert.equal(createI18n("ko").t("toolCard.state.done"), "완료");
});

test("영어 사전에 없는 키는 한국어로 보인다", () => {
  const i18n = createI18n("en");
  i18n.addResourceBundle("ko", "translation", { __only_ko: "한국어만" }, true, true);
  assert.equal(i18n.t("__only_ko" as never), "한국어만");
});

/** 사전을 "a.b.c" → 값 으로 편다. */
function flatten(obj: object, prefix = ""): Map<string, string> {
  const out = new Map<string, string>();
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.set(key, v);
    else for (const [kk, vv] of flatten(v as object, key)) out.set(kk, vv);
  }
  return out;
}
const vars = (s: string) => [...s.matchAll(/\{\{\s*([\w.]+)/g)].map((m) => m[1]).sort().join(",");

test("영어 사전은 한국어 사전의 키만 쓰고, 빈 값이 없고, 보간 변수가 같다", () => {
  const k = flatten(ko);
  for (const [key, value] of flatten(en)) {
    assert.ok(k.has(key), `한국어 사전에 없는 키: ${key}`);
    assert.notEqual(value.trim(), "", `빈 번역: ${key}`);
    assert.equal(vars(value), vars(k.get(key)!), `보간 변수가 다르다: ${key}`);
  }
  for (const [key, value] of k) assert.notEqual(value.trim(), "", `빈 문구: ${key}`);
});

test("영어 사전에 빠진 키가 없다", () => {
  const e = flatten(en);
  // "__" 로 시작하는 키는 위 테스트가 넣은 임시 키다
  const missing = [...flatten(ko).keys()].filter((key) => !key.startsWith("__") && !e.has(key));
  assert.deepEqual(missing, []);
});

test("저장된 문구는 지금 언어로 번역되고, 모르는 키나 깨진 값은 함께 저장한 문장으로 보인다", () => {
  const koI = createI18n("ko");
  const enI = createI18n("en");
  const msg: Msg = { key: "session.msg.interrupted" };
  assert.equal(msgText(koI, msg, "x"), "중단됨");
  assert.equal(msgText(enI, msg, "x"), "Stopped");
  assert.equal(msgText(enI, undefined, "외부 오류"), "외부 오류");
  assert.equal(msgText(enI, { key: "session.msg.__gone" } as never, "예전 문장"), "예전 문장");
  assert.equal(msgText(enI, { key: "settings.title" } as never, "예전 문장"), "예전 문장");
  assert.equal(msgText(enI, { key: 3 } as never, "예전 문장"), "예전 문장");
  // 복수형 키는 count 로 찾는다
  assert.equal(msgText(enI, { key: "main.msg.reviewScope", params: { count: 1, added: 3, deleted: 0 } }, "x"), "1 file · +3 −0");
  assert.equal(msgText(enI, { key: "main.msg.reviewScope", params: { count: 2, added: 3, deleted: 0 } }, "x"), "2 files · +3 −0");
  // 시각은 ms 로 저장하고 사전의 datetime 포맷이 언어에 맞게 그린다
  const until = new Date(2026, 9, 2, 15, 30).getTime();
  const limit: Msg = { key: "session.msg.limit.retryAt", params: { until, attempts: 2 } };
  assert.match(msgText(koI, limit, "x"), /(오후|PM) 03:30 에 자동으로 다시 시도합니다 \(2번째\)/);
  assert.match(msgText(enI, limit, "x"), /at 03:30 PM \(attempt 2\)/);
});
