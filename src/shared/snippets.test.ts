import { test } from "node:test";
import assert from "node:assert/strict";
import {
  filterSnippets,
  normalizeSnippetName,
  snippetSummary,
  upsertSnippet,
  type SnippetDto,
} from "./snippets";

const mkS = (name: string, ws: string | null, id: string): SnippetDto => ({ id, name, text: "x", workspaceId: ws, updatedAt: 1 });
const mk = (name: string, ws: string | null, text = "x"): SnippetDto => ({
  id: name + (ws ?? ""),
  name,
  text,
  workspaceId: ws,
  updatedAt: 1,
});

test("normalizeSnippetName / snippetSummary", () => {
  assert.equal(normalizeSnippetName(" /간결하게 답해 "), "간결하게-답해");
  assert.equal(normalizeSnippetName("Brief"), "brief");
  assert.equal(snippetSummary("첫 줄\n둘째 줄"), "첫 줄");
  assert.equal(snippetSummary("a".repeat(100), 10), "aaaaaaaaa…");
});

test("filterSnippets: 전체 + 현재 워크스페이스만, 접두 우선", () => {
  const all = [mk("brief", null), mk("tdd", "w1"), mk("review", "w2"), mk("abrief", null)];
  assert.deepEqual(filterSnippets(all, "", "w1").map((s) => s.name), ["abrief", "brief", "tdd"]);
  assert.deepEqual(filterSnippets(all, "brief", "w1").map((s) => s.name), ["brief", "abrief"]);
  assert.deepEqual(filterSnippets(all, "rev", "w1"), []);
});

test("upsertSnippet: 검증, 같은 이름·범위 덮어쓰기, id 로 교체", () => {
  let id = 0;
  const newId = () => `n${++id}`;
  assert.deepEqual(upsertSnippet([], { name: " ", text: "x", workspaceId: null }, 1, newId), { error: "이름을 입력하세요." });
  assert.deepEqual(upsertSnippet([], { name: "a", text: "  ", workspaceId: null }, 1, newId), { error: "내용이 비어 있습니다." });
  const r1 = upsertSnippet([], { name: "Brief", text: "간결하게.\n", workspaceId: null }, 5, newId);
  assert.ok("snippet" in r1);
  if (!("snippet" in r1)) return;
  assert.deepEqual(r1.snippet, { id: "n1", name: "brief", text: "간결하게.", workspaceId: null, updatedAt: 5 });
  // 같은 이름 같은 범위 → 덮어쓰기(id 유지)
  const r2 = upsertSnippet(r1.snippets, { name: "brief", text: "더 간결하게", workspaceId: null }, 6, newId);
  if (!("snippet" in r2)) return assert.fail();
  assert.equal(r2.snippets.length, 1);
  assert.equal(r2.snippet.id, "n1");
  // 같은 이름 다른 범위 → 별개
  const r3 = upsertSnippet(r2.snippets, { name: "brief", text: "ws", workspaceId: "w1" }, 7, newId);
  if (!("snippet" in r3)) return assert.fail();
  assert.equal(r3.snippets.length, 2);
  // id 로 이름 변경
  const r4 = upsertSnippet(r3.snippets, { id: "n1", name: "short", text: "s", workspaceId: null }, 8, newId);
  if (!("snippet" in r4)) return assert.fail();
  assert.deepEqual(r4.snippets.map((s) => s.name).sort(), ["brief", "short"]);
  // id 로 편집해 다른 스니펫과 같은 이름(같은 범위)이 되면 그쪽을 흡수해 하나만 남는다
  const base = [mkS("x", null, "id-x"), mkS("y", null, "id-y")];
  const r5 = upsertSnippet(base, { id: "id-y", name: "x", text: "yy", workspaceId: null }, 9, newId);
  if (!("snippet" in r5)) return assert.fail();
  assert.deepEqual(r5.snippets.map((s) => [s.id, s.name]), [["id-y", "x"]]);
  // 한도
  assert.ok("error" in upsertSnippet([], { name: "a".repeat(65), text: "t", workspaceId: null }, 1, newId));
  assert.ok("error" in upsertSnippet([], { name: "a", text: "t".repeat(20_001), workspaceId: null }, 1, newId));
});
