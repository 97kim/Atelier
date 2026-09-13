import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrateKv, kvGet } from "./kv-store";
import { clearComposerDraft, flushComposerDrafts, loadComposerDraft, pruneComposerDrafts, saveComposerDraft } from "./composer-draft";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stored = (tabId: string) => kvGet(`composerDraft.${tabId}`);

test("입력창 초안: 탭별로 저장·복원하고, 빈 글·너무 긴 글은 지우고, 전송(clear) 하면 없어진다", async () => {
  hydrateKv({ "composerDraft.restored": "지난번 글" }, () => {});
  assert.equal(loadComposerDraft("restored"), "지난번 글", "시작 때 받은 값을 읽는다");
  assert.equal(loadComposerDraft("t1"), "");
  saveComposerDraft("t1", "빠른 입력");
  assert.equal(loadComposerDraft("t1"), "빠른 입력", "저장이 예약된 동안에도(탭 왕복) 최신 입력을 읽는다");
  saveComposerDraft("t1", "쓰다 ");
  saveComposerDraft("t1", "쓰다 만 글");
  saveComposerDraft("t2", "다른 탭");
  await wait(400);
  assert.equal(stored("t1"), "쓰다 만 글", "마지막 값만 남는다");
  assert.equal(stored("t2"), "다른 탭");
  saveComposerDraft("t2", "   ");
  await wait(400);
  assert.equal(stored("t2"), null, "공백뿐이면 저장소에서 지운다(캐시는 입력창 그대로)");
  saveComposerDraft("t2", "x".repeat(200_001));
  await wait(400);
  assert.equal(stored("t2"), null, "너무 길면 저장하지 않는다");
  saveComposerDraft("t1", "아직 안 씀");
  clearComposerDraft("t1"); // 전송·탭 삭제
  await wait(400);
  assert.equal(loadComposerDraft("t1"), "");
  assert.equal(stored("t1"), null, "예약된 저장도 취소된다");
  // 모델에 없는 탭의 초안은 정리된다
  saveComposerDraft("gone", "지워질 글");
  saveComposerDraft("kept", "남을 글");
  await wait(400);
  pruneComposerDrafts(new Set(["kept"]));
  assert.equal(stored("gone"), null);
  assert.equal(stored("restored"), null, "시작 때 받았어도 모델에 없으면 지운다");
  assert.equal(stored("kept"), "남을 글");
  // 종료 직전 flush 는 예약된 저장을 실제로 쓴다
  saveComposerDraft("kept", "마지막 입력");
  flushComposerDrafts();
  assert.equal(stored("kept"), "마지막 입력");
});
