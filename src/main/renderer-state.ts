// 렌더러가 맡긴 작은 상태(열린 파일·미저장 초안·입력창 초안)를 userData/renderer-state.json 에 둔다.
// localStorage 를 쓰지 않는 이유: Chromium 은 localStorage 를 몇 초 늦게 디스크에 쓰므로 그 사이 앱이 죽으면 마지막 편집이 사라진다.
// 여기서는 값이 올 때마다 바로 파일에 쓴다(임시 파일 → rename 으로 원자적).
import fs from "node:fs";
import path from "node:path";

const FILE = "renderer-state.json";
/** 키 하나의 값 상한. 에디터 초안(1MB)과 탭 목록을 넉넉히 담는다. */
export const RENDERER_STATE_VALUE_MAX = 4 * 1024 * 1024;
export const RENDERER_STATE_KEY_MAX = 200;

export class RendererState {
  private entries: Map<string, string> | null = null;
  constructor(private readonly dir: string) {}

  private file() {
    return path.join(this.dir, FILE);
  }

  private ensure(): Map<string, string> {
    if (this.entries) return this.entries;
    const m = new Map<string, string>();
    try {
      const raw = JSON.parse(fs.readFileSync(this.file(), "utf8")) as unknown;
      if (raw && typeof raw === "object") for (const [k, v] of Object.entries(raw as Record<string, unknown>)) if (typeof v === "string") m.set(k, v);
    } catch {
      /* 없거나 깨짐 — 빈 상태로 시작 */
    }
    this.entries = m;
    return m;
  }

  load(): Record<string, string> {
    return Object.fromEntries(this.ensure());
  }

  /** value 가 null 이면 지운다. 바뀐 게 없으면 파일을 다시 쓰지 않는다. */
  set(key: string, value: string | null): void {
    if (typeof key !== "string" || key.length === 0 || key.length > RENDERER_STATE_KEY_MAX) return;
    if (value !== null && (typeof value !== "string" || value.length > RENDERER_STATE_VALUE_MAX)) return;
    const m = this.ensure();
    if (value === null ? !m.delete(key) : m.get(key) === value) return;
    if (value !== null) m.set(key, value);
    this.write(m);
  }

  private write(m: Map<string, string>) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      const tmp = `${this.file()}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(m)), "utf8");
      fs.renameSync(tmp, this.file());
    } catch (e) {
      console.error("[renderer-state] 저장 실패:", e);
    }
  }
}
