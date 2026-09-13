// CLI 가 스스로 쓰는 기본 모델. 앱의 "기본 (CLI 설정)" 항목에 실제 이름을 붙여 주기 위해 설정 파일에서 읽는다 — 이름을 추측하지 않는다.
import fs from "node:fs";
import { join } from "node:path";
import type { Provider } from "@shared/ipc";

/** ~/.claude/settings.json 의 "model", ~/.codex/config.toml 의 최상위 `model = "…"`. 없거나 못 읽으면 null. */
export function readCliDefaultModel(provider: Provider, home: string): string | null {
  try {
    if (provider === "claude") {
      const raw = JSON.parse(fs.readFileSync(join(home, ".claude", "settings.json"), "utf8")) as { model?: unknown };
      return typeof raw.model === "string" && raw.model.trim() ? raw.model.trim() : null;
    }
    return codexTopLevelModel(fs.readFileSync(join(home, ".codex", "config.toml"), "utf8"));
  } catch {
    return null;
  }
}

/** TOML 을 다 파싱하지 않고 첫 `[section]` 이전의 `model = "…"` 만 본다(프로필·MCP 섹션의 model 은 다른 뜻). */
export function codexTopLevelModel(toml: string): string | null {
  for (const line of toml.split("\n")) {
    const t = line.trim();
    if (t.startsWith("[")) break;
    const m = /^model\s*=\s*"([^"]*)"/.exec(t);
    if (m) return m[1].trim() || null;
  }
  return null;
}
