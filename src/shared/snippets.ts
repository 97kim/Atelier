// 프롬프트 스니펫: 자주 붙이는 지시문을 이름으로 저장해 입력창의 "/" 팔레트에서 꺼내 쓴다.
// 워크스페이스별(workspaceId) 또는 전체(null). 순수 함수만 — 저장은 main/snippets.ts.
import type { TFunction } from "i18next";

export interface SnippetDto {
  id: string;
  /** "/" 뒤에 치는 이름. 공백 없음, 소문자 권장. */
  name: string;
  text: string;
  /** null 이면 모든 워크스페이스에서 보인다. */
  workspaceId: string | null;
  updatedAt: number;
}

export const MAX_NAME = 64;
export const MAX_TEXT = 20_000;
export const MAX_COUNT = 500;

/** 이름 정규화: 앞의 "/" 와 공백 제거, 내부 공백은 "-" 로. */
export function normalizeSnippetName(raw: string): string {
  return raw
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, "-")
    .toLowerCase();
}

/** 팔레트 한 줄 설명: 본문 첫 줄을 잘라 쓴다. */
export function snippetSummary(text: string, max = 80): string {
  const first = text.trim().split("\n")[0] ?? "";
  return first.length > max ? `${first.slice(0, max - 1)}…` : first;
}

/** 이 워크스페이스에서 보이는 스니펫: 전체 + 해당 워크스페이스. 접두 일치를 앞에, 부분 일치를 뒤에. */
export function filterSnippets(
  snippets: SnippetDto[],
  query: string,
  workspaceId: string | null,
): SnippetDto[] {
  const q = query.toLowerCase();
  const visible = snippets.filter((s) => s.workspaceId === null || s.workspaceId === workspaceId);
  const prefix = visible.filter((s) => !q || s.name.toLowerCase().startsWith(q));
  const partial = visible.filter((s) => q && !s.name.toLowerCase().startsWith(q) && s.name.toLowerCase().includes(q));
  const byName = (a: SnippetDto, b: SnippetDto) => a.name.localeCompare(b.name);
  return [...prefix.sort(byName), ...partial.sort(byName)];
}

/** 저장(upsert): 같은 id 는 교체, 없으면 추가. 같은 범위에 같은 이름이 이미 있으면 그것을 덮어쓴다. */
export function upsertSnippet(
  t: TFunction,
  snippets: SnippetDto[],
  input: { id?: string; name: string; text: string; workspaceId: string | null },
  now: number,
  newId: () => string,
): { snippets: SnippetDto[]; snippet: SnippetDto } | { error: string } {
  const name = normalizeSnippetName(input.name);
  const text = input.text.replace(/\s+$/, "");
  if (!name) return { error: t("main.snippet.nameRequired") };
  if (name.length > MAX_NAME) return { error: t("main.snippet.nameTooLong", { max: MAX_NAME }) };
  if (!text.trim()) return { error: t("main.error.emptyContent") };
  if (text.length > MAX_TEXT) return { error: t("main.snippet.textTooLong", { max: MAX_TEXT.toLocaleString() }) };
  // 같은 범위·같은 이름은 하나만 — id 로 편집해 다른 스니펫과 이름이 겹치면 그쪽을 흡수한다.
  const dup = snippets.find(
    (s) => s.id !== input.id && s.name === name && s.workspaceId === input.workspaceId,
  );
  const id = input.id ?? dup?.id ?? newId();
  const rest = snippets.filter((s) => s.id !== id && s.id !== dup?.id);
  if (!input.id && !dup && rest.length >= MAX_COUNT) return { error: t("main.snippet.tooMany", { max: MAX_COUNT }) };
  const snippet: SnippetDto = { id, name, text, workspaceId: input.workspaceId, updatedAt: now };
  return { snippets: [...rest, snippet], snippet };
}
