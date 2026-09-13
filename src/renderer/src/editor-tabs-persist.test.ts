// 별도 파일인 이유: 모듈이 처음 접근 때 kv-store 를 한 번만 읽으므로, 저장소를 미리 채워 두고 import 해야 복원을 검증할 수 있다.
import { test } from "node:test";
import assert from "node:assert/strict";
import { hydrateKv, kvGet } from "./kv-store";

test("에디터 탭·미저장 본문은 kv-store 에서 복원되고, 바뀌면 다시 저장된다", async () => {
  const writes: [string, string | null][] = [];
  hydrateKv(
    {
      "editorTabs.v1": JSON.stringify({
        states: {
          t1: { files: ["/r/a.ts", "/r/b.ts"], active: "/r/b.ts", visible: true, dirty: ["/r/b.ts", "/r/not-open.ts"] },
          empty: { files: [] },
        },
        drafts: { "/r/b.ts": { text: "draft b", mtimeMs: 5, size: 7 }, "/r/bad.ts": { text: 123 } },
      }),
    },
    (k, v) => writes.push([k, v]),
  );
  const m = await import("./editor-tabs");
  const st = m.getEditorTabs("t1");
  assert.deepEqual(st.files, ["/r/a.ts", "/r/b.ts"]);
  assert.equal(st.active, "/r/b.ts");
  assert.equal(st.visible, true);
  assert.deepEqual(st.dirty, ["/r/b.ts"], "열려 있지 않은 경로의 dirty 는 버린다");
  assert.deepEqual(st.reveal, null);
  assert.deepEqual(m.getEditorTabs("empty").files, []);
  assert.deepEqual(m.getEditorDraft("/r/b.ts"), { text: "draft b", mtimeMs: 5, size: 7 });
  assert.equal(m.getEditorDraft("/r/bad.ts"), null, "모양이 틀린 초안은 버린다");

  // 바꾸면 잠깐 뒤 저장된다(flush 로 지금)
  m.openEditorFile("t2", "/r/c.ts");
  m.setEditorDraft("/r/c.ts", { text: "typing c", mtimeMs: null, size: null });
  m.flushEditorTabsStorage();
  const saved = JSON.parse(kvGet("editorTabs.v1")!);
  assert.deepEqual(saved.states.t2, { files: ["/r/c.ts"], active: "/r/c.ts", visible: true, dirty: [] });
  assert.equal(saved.drafts["/r/c.ts"].text, "typing c");
  assert.equal("reveal" in saved.states.t2, false);
  assert.ok(writes.some(([k]) => k === "editorTabs.v1"), "main 으로 쓰기가 나간다");
  // 1MB 를 넘는 초안은 메모리에만
  m.setEditorDraft("/r/huge.ts", { text: "x".repeat(1_000_001), mtimeMs: null, size: null });
  m.flushEditorTabsStorage();
  assert.equal("/r/huge.ts" in JSON.parse(kvGet("editorTabs.v1")!).drafts, false);
  assert.ok(m.getEditorDraft("/r/huge.ts"));
  // 탭 삭제 → 그 탭만 편집 중이던 초안도 사라진다
  m.setEditorFileDirty("t2", "/r/c.ts", true);
  m.forgetEditorTabs("t2");
  m.flushEditorTabsStorage();
  const after = JSON.parse(kvGet("editorTabs.v1")!);
  assert.equal("t2" in after.states, false);
  assert.equal("/r/c.ts" in after.drafts, false);
  assert.equal(m.getEditorDraft("/r/b.ts")?.text, "draft b", "다른 탭 것은 그대로");
  // 모델에 없는 탭은 정리, 있는 탭은 유지
  m.openEditorFile("t3", "/r/d.ts");
  m.pruneEditorTabs(new Set(["t1"]));
  assert.deepEqual(m.getEditorTabs("t3").files, []);
  assert.deepEqual(m.getEditorTabs("t1").files, ["/r/a.ts", "/r/b.ts"]);
  // 재시작 뒤 복원된 browser:1 과 새 브라우저 탭 키가 겹치지 않는다
  m.openEditorFile("t1", "browser:1");
  m.openBrowserTab("t1");
  const files = m.getEditorTabs("t1").files;
  assert.equal(files.filter((f) => f.startsWith("browser:")).length, 2, "새 빈 브라우저 탭이 하나 더 생긴다");
});
