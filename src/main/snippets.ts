// 스니펫 저장소: userData/snippets.json. 바뀔 때마다 onChange 로 renderer 에 전체 목록을 뿌린다.
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { upsertSnippet, type SnippetDto } from "@shared/snippets";

export class SnippetStore {
  private items: SnippetDto[];

  constructor(
    private readonly file: string,
    private readonly onChange?: (items: SnippetDto[]) => void,
  ) {
    this.items = this.load();
  }

  list(): SnippetDto[] {
    return this.items.slice();
  }

  save(input: { id?: string; name: string; text: string; workspaceId: string | null }):
    | { ok: true; snippet: SnippetDto }
    | { ok: false; error: string } {
    const r = upsertSnippet(this.items, input, Date.now(), randomUUID);
    if ("error" in r) return { ok: false, error: r.error };
    this.items = r.snippets;
    this.persist();
    return { ok: true, snippet: r.snippet };
  }

  remove(id: string): void {
    const next = this.items.filter((s) => s.id !== id);
    if (next.length === this.items.length) return;
    this.items = next;
    this.persist();
  }

  /** 워크스페이스가 지워지면 그 범위의 스니펫도 지운다. */
  removeWorkspace(workspaceId: string): void {
    const next = this.items.filter((s) => s.workspaceId !== workspaceId);
    if (next.length === this.items.length) return;
    this.items = next;
    this.persist();
  }

  private load(): SnippetDto[] {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(raw)
        ? raw.filter(
            (s): s is SnippetDto =>
              s && typeof s.id === "string" && typeof s.name === "string" && typeof s.text === "string",
          )
        : [];
    } catch {
      return [];
    }
  }

  private persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.items, null, 2), "utf8");
    } catch (e) {
      console.error("[snippets] 저장 실패:", e);
    }
    this.onChange?.(this.list());
  }
}
