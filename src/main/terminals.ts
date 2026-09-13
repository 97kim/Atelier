// 채팅 탭마다 하나씩 붙는 통합 터미널. node-pty 로 사용자 셸을 워크스페이스 cwd 에서 띄우고
// 출력은 renderer 의 xterm 으로 흘려보낸다. 패널을 닫아도 셸은 살아 있고, 탭을 닫으면 죽인다.

import fs from "node:fs";
import path from "node:path";
import type { IPty } from "node-pty";

export interface TerminalOpenResult {
  ok: boolean;
  /** 이미 떠 있는 셸에 다시 붙은 경우 true (renderer 가 버퍼를 새로 그리지 않아도 됨). */
  existing: boolean;
  shell: string;
  pid?: number;
  error?: string;
  /** existing 일 때 최근 출력(최대 BACKLOG_MAX). renderer 가 xterm 에 그대로 써서 화면을 복원한다. */
  backlog?: string;
}

export interface TerminalInfo {
  id: string;
  kind: TerminalKind;
  title: string;
}

/** 터미널당 보관하는 출력 백로그 상한. */
const BACKLOG_MAX = 200_000;

export type TerminalKind = "shell" | "command";

export interface TerminalManagerDeps {
  onData(tabId: string, data: string): void;
  /** kind="command" 는 openCommand 로 띄운 CLI(터미널 모드)가 끝난 것. */
  onExit(tabId: string, exitCode: number, kind: TerminalKind): void;
  /** 새 pty 가 생겼을 때 (renderer 가 탭을 추가하도록). */
  onOpen?(info: TerminalInfo): void;
  log?(line: string): void;
}

interface Entry {
  pty: IPty;
  shell: string;
  kind: TerminalKind;
  backlog: string;
  cwd: string;
}

/** node-pty 는 네이티브 모듈이라 로드 실패가 앱 전체를 죽이지 않도록 첫 사용 시점에 require 한다. */
function loadPty(): typeof import("node-pty") {
  ensureSpawnHelperExecutable();
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node-pty") as typeof import("node-pty");
}

/**
 * yarn 1 이 prebuilds 의 실행 권한을 떨어뜨리면 spawn 이 "posix_spawnp failed" 로 실패한다.
 * postinstall 에서도 chmod 하지만, 패키지 앱(asar unpacked)에서도 안전하게 한 번 더 확인한다.
 */
function ensureSpawnHelperExecutable() {
  try {
    const dir = path.dirname(require.resolve("node-pty/package.json"));
    const helper = path.join(
      dir,
      "prebuilds",
      `${process.platform}-${process.arch}`,
      "spawn-helper",
    );
    if (fs.existsSync(helper) && (fs.statSync(helper).mode & 0o111) === 0)
      fs.chmodSync(helper, 0o755);
  } catch {
    /* 읽기 전용 위치면 spawn 시점에 오류로 드러난다 */
  }
}

export class TerminalManager {
  private readonly entries = new Map<string, Entry>();

  constructor(private readonly deps: TerminalManagerDeps) {}

  open(
    tabId: string,
    cwd: string,
    env: Record<string, string>,
    cols: number,
    rows: number,
  ): TerminalOpenResult {
    const cur = this.entries.get(tabId);
    if (cur) {
      this.safeResize(cur.pty, cols, rows);
      return {
        ok: true,
        existing: true,
        shell: cur.shell,
        pid: cur.pty.pid,
        backlog: cur.backlog,
      };
    }
    const shell = env.SHELL || process.env.SHELL || "/bin/zsh";
    // node-pty 는 cwd 가 없어도 spawn 자체는 성공하고 셸이 바로 죽는다. 미리 걸러서 이유를 알려 준다.
    if (!fs.existsSync(cwd)) {
      return {
        ok: false,
        existing: false,
        shell,
        error: `작업 디렉토리가 없습니다: ${cwd}`,
      };
    }
    try {
      const pty = loadPty().spawn(shell, ["-l"], {
        name: "xterm-256color",
        cols: Math.max(2, cols || 80),
        rows: Math.max(1, rows || 24),
        cwd,
        env: {
          ...env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: env.LANG || "ko_KR.UTF-8",
        },
      });
      const entry: Entry = { pty, shell, kind: "shell", backlog: "", cwd };
      this.wire(tabId, entry);
      this.entries.set(tabId, entry);
      this.deps.onOpen?.({
        id: tabId,
        kind: "shell",
        title: path.basename(shell),
      });
      this.deps.log?.(`open ${tabId} pid=${pty.pid} shell=${shell} cwd=${cwd}`);
      return { ok: true, existing: false, shell, pid: pty.pid };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`open ${tabId} 실패: ${message}`);
      return { ok: false, existing: false, shell, error: message };
    }
  }

  /**
   * 터미널 모드: 셸 대신 CLI(claude/codex)를 이 탭의 pty 로 직접 띄운다. 기존 셸은 끊는다.
   * 프로세스가 끝나면 onExit(kind="command") 가 와서 세션 제어가 앱으로 돌아간다.
   */
  openCommand(
    tabId: string,
    cwd: string,
    env: Record<string, string>,
    file: string,
    args: string[],
    cols = 100,
    rows = 30,
  ): TerminalOpenResult {
    this.close(tabId);
    try {
      const pty = loadPty().spawn(file, args, {
        name: "xterm-256color",
        cols: Math.max(2, cols),
        rows: Math.max(1, rows),
        cwd,
        env: {
          ...env,
          TERM: "xterm-256color",
          COLORTERM: "truecolor",
          LANG: env.LANG || "ko_KR.UTF-8",
        },
      });
      const entry: Entry = {
        pty,
        shell: `${path.basename(file)} ${args.join(" ")}`.trim(),
        kind: "command",
        backlog: "",
        cwd,
      };
      this.wire(tabId, entry);
      this.entries.set(tabId, entry);
      this.deps.onOpen?.({
        id: tabId,
        kind: "command",
        title: path.basename(file),
      });
      this.deps.log?.(
        `command ${tabId} pid=${pty.pid} ${entry.shell} cwd=${cwd}`,
      );
      return { ok: true, existing: false, shell: entry.shell, pid: pty.pid };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      this.deps.log?.(`command ${tabId} 실패: ${message}`);
      return { ok: false, existing: false, shell: file, error: message };
    }
  }

  /** 살아 있는 사용자 셸(kind=shell)들 — 외부 CLI 감지용. termId 는 "<채팅탭 id>:<n>" 이라 앞부분이 탭 id 다. */
  shells(): { termId: string; tabId: string; pid: number; cwd: string }[] {
    const out: { termId: string; tabId: string; pid: number; cwd: string }[] = [];
    for (const [id, e] of this.entries) if (e.kind === "shell") out.push({ termId: id, tabId: id.split(":")[0], pid: e.pty.pid, cwd: e.cwd });
    return out;
  }

  kindOf(tabId: string): TerminalKind | null {
    return this.entries.get(tabId)?.kind ?? null;
  }

  private wire(tabId: string, entry: Entry) {
    entry.pty.onData((data) => {
      entry.backlog = (entry.backlog + data).slice(-BACKLOG_MAX);
      this.deps.onData(tabId, data);
    });
    entry.pty.onExit(({ exitCode }) => {
      // close() 로 교체된 뒤 늦게 오는 exit 는 새 항목을 지우면 안 된다.
      if (this.entries.get(tabId) === entry) this.entries.delete(tabId);
      this.deps.onExit(tabId, exitCode, entry.kind);
    });
  }

  write(tabId: string, data: string): boolean {
    const cur = this.entries.get(tabId);
    if (!cur) return false;
    cur.pty.write(data);
    return true;
  }

  resize(tabId: string, cols: number, rows: number): void {
    const cur = this.entries.get(tabId);
    if (cur) this.safeResize(cur.pty, cols, rows);
  }

  has(tabId: string): boolean {
    return this.entries.has(tabId);
  }

  /** 접두어(보통 "<채팅탭 id>:")로 시작하는 터미널 목록. 생성 순서. */
  list(prefix: string): TerminalInfo[] {
    const out: TerminalInfo[] = [];
    for (const [id, e] of this.entries) {
      if (id.startsWith(prefix))
        out.push({
          id,
          kind: e.kind,
          title:
            e.kind === "shell" ? path.basename(e.shell) : e.shell.split(" ")[0],
        });
    }
    return out;
  }

  /** 채팅 탭을 닫을 때: 그 탭의 터미널을 모두 종료. */
  closePrefix(prefix: string): void {
    for (const id of [...this.entries.keys()])
      if (id.startsWith(prefix)) this.close(id);
  }

  /** 탭이 닫히거나 사용자가 종료를 눌렀을 때. exit 콜백은 pty 가 실제로 죽으면 온다. */
  close(tabId: string): void {
    const cur = this.entries.get(tabId);
    if (!cur) return;
    this.entries.delete(tabId);
    try {
      cur.pty.kill();
    } catch {
      /* 이미 죽은 프로세스 */
    }
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.close(id);
  }

  private safeResize(pty: IPty, cols: number, rows: number) {
    if (cols < 2 || rows < 1) return;
    try {
      pty.resize(cols, rows);
    } catch {
      /* 종료 직후의 resize 는 무시 */
    }
  }
}
