import { test } from "node:test";
import assert from "node:assert/strict";
import { LSP_SERVERS, isLspServerId, lspServerForPath, lspServerSpec } from "./lsp-servers";

test("lsp-servers: 확장자 → 서버·languageId, 모르는 확장자는 null", () => {
  assert.deepEqual(lspServerForPath("/r/a.tsx") && [lspServerForPath("/r/a.tsx")!.server.id, lspServerForPath("/r/a.tsx")!.languageId], ["typescript", "typescriptreact"]);
  assert.deepEqual(lspServerForPath("/r/x.PY") && [lspServerForPath("/r/x.PY")!.server.id, lspServerForPath("/r/x.PY")!.languageId], ["python", "python"]);
  assert.equal(lspServerForPath("/r/README.md"), null);
  assert.equal(lspServerForPath("/r/noext"), null);
  assert.equal(isLspServerId("python"), true);
  assert.equal(isLspServerId("rust"), false);
  assert.equal(lspServerSpec("typescript")?.bin, "typescript-language-server");
  // 확장자가 두 서버에 겹치지 않는다
  const seen = new Map<string, string>();
  for (const s of LSP_SERVERS) for (const ext of Object.keys(s.languages)) {
    assert.equal(seen.has(ext), false, `${ext} 가 ${seen.get(ext)} 와 ${s.id} 에 겹침`);
    seen.set(ext, s.id);
  }
});
