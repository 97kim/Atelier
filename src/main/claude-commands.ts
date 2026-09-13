// 워크스페이스(cwd)별 Claude Code 슬래시 커맨드 목록 캐시.
//
// 목록은 CLI 프로세스가 떠 있어야 받을 수 있다. 첫 메시지 전에도 보여주기 위해 스트리밍 입력 모드로
// query() 를 열어 initialize 응답(commands)만 받고 바로 닫는다(프롬프트를 보내지 않으므로 턴·비용 없음).
// 턴 도중 init 메시지의 terminal_slash_commands 와 commands_changed 푸시로 캐시를 갱신한다.

import fs from "node:fs";
import path from "node:path";
import { TERMINAL_ONLY_COMMANDS, type SlashCommandDto } from "@shared/slash-commands";
import type { ClaudeRuntime } from "./claude-adapter";
import { withControlQuery } from "./claude-control";

interface Entry {
  commands: SlashCommandDto[];
  /** init 메시지가 준 터미널 전용 명령. 없으면 TERMINAL_ONLY_COMMANDS 폴백. */
  terminal: string[] | null;
  fetchedAt: number;
}

interface FileShape {
  version: 1;
  entries: Record<string, Entry>;
}

const STALE_MS = 10 * 60 * 1000;

export interface SlashCommandPatch {
  commands?: SlashCommandDto[];
  terminal?: string[];
}

export class SlashCommandCache {
  private entries = new Map<string, Entry>();
  private readonly inflight = new Map<string, Promise<SlashCommandDto[]>>();
  private loaded = false;

  constructor(
    private readonly filePath: string,
    private readonly onChange?: (cwd: string) => void,
    private readonly log?: (line: string) => void,
  ) {}

  /** 캐시된 목록(터미널 전용 제외). 없으면 null. */
  peek(cwd: string): SlashCommandDto[] | null {
    this.load();
    const e = this.entries.get(cwd);
    return e ? this.visible(e) : null;
  }

  /**
   * 캐시가 있으면 즉시 돌려주고(오래됐으면 뒤에서 갱신), 없으면 프로세스를 띄워 받아온다.
   * 같은 cwd 의 동시 요청은 하나로 합친다.
   */
  async get(cwd: string, runtime: () => Promise<ClaudeRuntime>): Promise<SlashCommandDto[]> {
    this.load();
    const cached = this.entries.get(cwd);
    if (cached) {
      if (Date.now() - cached.fetchedAt > STALE_MS) void this.refresh(cwd, runtime);
      return this.visible(cached);
    }
    return this.refresh(cwd, runtime);
  }

  /** 턴 도중 받은 정보 반영 (init 의 terminal 목록, commands_changed 의 전체 목록). */
  apply(cwd: string, patch: SlashCommandPatch): void {
    this.load();
    const prev = this.entries.get(cwd);
    const next: Entry = {
      commands: patch.commands ?? prev?.commands ?? [],
      terminal: patch.terminal ?? prev?.terminal ?? null,
      fetchedAt: patch.commands ? Date.now() : (prev?.fetchedAt ?? 0),
    };
    if (prev && sameEntry(prev, next)) return;
    this.entries.set(cwd, next);
    this.save();
    this.onChange?.(cwd);
  }

  private refresh(cwd: string, runtime: () => Promise<ClaudeRuntime>): Promise<SlashCommandDto[]> {
    let p = this.inflight.get(cwd);
    if (p) return p;
    p = (async () => {
      try {
        const rt = await runtime();
        const commands = await fetchSlashCommands(rt, cwd, this.log);
        this.apply(cwd, { commands });
        return this.visible(this.entries.get(cwd)!);
      } catch (e) {
        this.log?.(`slash command fetch failed (${cwd}): ${e instanceof Error ? e.message : String(e)}`);
        const e2 = this.entries.get(cwd);
        return e2 ? this.visible(e2) : [];
      } finally {
        this.inflight.delete(cwd);
      }
    })();
    this.inflight.set(cwd, p);
    return p;
  }

  private visible(e: Entry): SlashCommandDto[] {
    const terminal = e.terminal ? new Set(e.terminal) : TERMINAL_ONLY_COMMANDS;
    return e.commands.filter((c) => !terminal.has(c.name));
  }

  private load(): void {
    if (this.loaded) return;
    this.loaded = true;
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, "utf8")) as Partial<FileShape>;
      if (raw.version === 1 && raw.entries && typeof raw.entries === "object") {
        this.entries = new Map(Object.entries(raw.entries));
      }
    } catch {
      // 없거나 깨졌으면 빈 캐시로 시작
    }
  }

  private save(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const data: FileShape = { version: 1, entries: Object.fromEntries(this.entries) };
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(data), "utf8");
      fs.renameSync(tmp, this.filePath);
    } catch (e) {
      this.log?.(`slash command cache save failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}

function sameEntry(a: Entry, b: Entry): boolean {
  return (
    a.fetchedAt === b.fetchedAt &&
    JSON.stringify(a.terminal) === JSON.stringify(b.terminal) &&
    JSON.stringify(a.commands) === JSON.stringify(b.commands)
  );
}

/** 프롬프트 없이 CLI 를 띄워 initialize 응답의 commands 만 받는다 (claude-control.ts). */
export async function fetchSlashCommands(
  runtime: ClaudeRuntime,
  cwd: string,
  log?: (line: string) => void,
): Promise<SlashCommandDto[]> {
  return withControlQuery(
    runtime,
    cwd,
    async (q) => {
      const init = await q.initializationResult();
      return init.commands.map((c) => ({
        name: c.name,
        description: c.description ?? "",
        argumentHint: c.argumentHint ?? "",
        aliases: c.aliases && c.aliases.length > 0 ? c.aliases : undefined,
      }));
    },
    log,
  );
}
