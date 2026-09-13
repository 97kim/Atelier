import { test } from "node:test";
import assert from "node:assert/strict";
import { buildDraftPrompt, cleanDraft } from "./git-draft";

test("cleanDraft: 코드 펜스·여분 공백 제거", () => {
  assert.equal(cleanDraft("```\nFix thing\n\n- a\n```"), "Fix thing\n\n- a");
  assert.equal(cleanDraft("  Title\n\n\n\n- b  "), "Title\n\n- b");
  assert.equal(cleanDraft(""), "");
  // 설명을 곁들인 출력: 펜스 안쪽만
  assert.equal(
    cleanDraft("커밋 메시지를 작성했습니다:\n\n```\nAdd mul\n\n- detail\n```\n\n변경 사항:\n- 어쩌구"),
    "Add mul\n\n- detail",
  );
  // 펜스 없이 머리말만 붙은 경우
  assert.equal(cleanDraft("커밋 메시지:\nAdd mul\n\n- detail"), "Add mul\n\n- detail");
});

test("buildDraftPrompt: 최근 제목을 스타일 힌트로 넣고 diff 를 펜스로 감싼다", () => {
  const p = buildDraftPrompt("diff --git a/x b/x", ["Add x", "Fix y"]);
  assert.match(p, /- Add x\n- Fix y/);
  assert.match(p, /```diff\ndiff --git a\/x b\/x\n```/);
  assert.doesNotMatch(buildDraftPrompt("d", []), /최근 커밋 제목/);
});
