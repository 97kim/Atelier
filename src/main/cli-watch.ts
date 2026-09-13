// 통합 터미널(사용자 셸)에서 직접 띄운 Claude Code·Codex 를 알아챈다.
// 셸 pty 의 자손 프로세스 목록을 주기적으로 훑어(ps 한 번) claude/codex 실행 파일이 있으면 "외부 CLI 가 시작됐다" 고 알리고,
// 사라지면 "끝났다" 고 알린다. 세션 매니저는 그 동안 기록 파일을 미러해 채팅에 따라 보여 준다.
import { execFile } from "node:child_process";
import type { Provider } from "@shared/ipc";

export interface CliProcess {
  pid: number;
  provider: Provider;
  /** `codex resume <id>` · `claude --resume <id>` 처럼 명령에 세션 id 가 있으면 그것. 첫 턴 전에도 어떤 세션인지 알 수 있다. */
  resumeId?: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** 실행 명령에서 이어받는 세션 id 를 뽑는다. `--last` 처럼 id 가 없거나 세션 이름이면 null. */
export function parseResumeId(args: string): string | null {
  const tok = args.trim().split(/\s+/);
  for (let i = 0; i < tok.length; i++) {
    if (tok[i] !== "resume" && tok[i] !== "--resume" && tok[i] !== "-r") continue;
    for (let j = i + 1; j < tok.length; j++) {
      if (tok[j].startsWith("-")) continue; // --last 같은 플래그는 건너뛴다
      return UUID.test(tok[j]) ? tok[j] : null;
    }
    return null;
  }
  return null;
}

export interface ShellInfo {
  tabId: string;
  pid: number;
  cwd: string;
}

/** `ps -axo pid=,ppid=,comm=` 출력을 pid → { ppid, comm } 으로. */
export function parsePsTree(out: string): Map<number, { ppid: number; comm: string }> {
  const m = new Map<number, { ppid: number; comm: string }>();
  for (const line of out.split("\n")) {
    const t = line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (t) m.set(Number(t[1]), { ppid: Number(t[2]), comm: t[3] });
  }
  return m;
}

function providerOf(comm: string): Provider | null {
  const base = comm.split("/").pop() ?? comm;
  if (base === "claude") return "claude";
  if (base === "codex") return "codex";
  return null;
}

/** root 의 자손 가운데 CLI 프로세스. 가장 가까운(얕은) 것부터. */
export function findCliDescendants(tree: Map<number, { ppid: number; comm: string }>, root: number): CliProcess[] {
  const children = new Map<number, number[]>();
  for (const [pid, { ppid }] of tree) {
    const arr = children.get(ppid);
    if (arr) arr.push(pid);
    else children.set(ppid, [pid]);
  }
  const out: CliProcess[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (seen.has(pid)) continue;
    seen.add(pid);
    for (const c of children.get(pid) ?? []) {
      const p = providerOf(tree.get(c)?.comm ?? "");
      if (p) out.push({ pid: c, provider: p });
      queue.push(c);
    }
  }
  return out;
}

function run(cmd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => execFile(cmd, args, { timeout: 4000, maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? "" : String(stdout))));
}

/** 프로세스의 실행 명령(ps). 못 읽으면 빈 문자열. */
export async function processArgs(pid: number): Promise<string> {
  return (await run("ps", ["-p", String(pid), "-o", "args="])).trim();
}

/** 프로세스의 작업 디렉토리(macOS: lsof). 못 읽으면 null. */
export async function processCwd(pid: number): Promise<string | null> {
  const out = await run("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-Fn"]);
  const n = out.split("\n").find((l) => l.startsWith("n/"));
  return n ? n.slice(1) : null;
}

export interface ShellCliMonitorDeps {
  shells(): ShellInfo[];
  onStart(tabId: string, cli: CliProcess & { cwd: string; resumeId: string | null }): void;
  onExit(tabId: string, pid: number): void;
  /** 테스트용: ps 출력을 대신 준다. */
  ps?: () => Promise<string>;
  cwdOf?: (pid: number) => Promise<string | null>;
  argsOf?: (pid: number) => Promise<string>;
  intervalMs?: number;
}

/** 셸이 하나라도 있는 동안만 주기적으로 ps 를 돈다. 탭당 CLI 하나만 추적한다(가장 얕은 것). */
export class ShellCliMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly tracked = new Map<string, number>(); // tabId → CLI pid
  private ticking = false;

  constructor(private readonly deps: ShellCliMonitorDeps) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.intervalMs ?? 1500);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const shells = this.deps.shells();
      const live = new Map<string, ShellInfo>();
      for (const s of shells) if (!live.has(s.tabId)) live.set(s.tabId, s);
      // 셸이 없어진 탭의 CLI 는 끝난 것
      for (const [tabId, pid] of [...this.tracked]) {
        if (!shells.some((s) => s.tabId === tabId)) {
          this.tracked.delete(tabId);
          this.deps.onExit(tabId, pid);
        }
      }
      if (shells.length === 0) return;
      const tree = parsePsTree(await (this.deps.ps ?? (() => run("ps", ["-axo", "pid=,ppid=,comm="])))());
      for (const [tabId] of live) {
        const cur = this.tracked.get(tabId);
        // 같은 탭의 셸 여러 개(터미널 탭)를 모두 본다
        const found = shells.filter((s) => s.tabId === tabId).flatMap((s) => findCliDescendants(tree, s.pid).map((c) => ({ ...c, shellCwd: s.cwd })));
        if (cur !== undefined) {
          if (!tree.has(cur)) {
            this.tracked.delete(tabId);
            this.deps.onExit(tabId, cur);
          }
          continue;
        }
        const first = found[0];
        if (!first) continue;
        this.tracked.set(tabId, first.pid);
        const cwd = (await (this.deps.cwdOf ?? processCwd)(first.pid)) ?? first.shellCwd;
        const resumeId = parseResumeId(await (this.deps.argsOf ?? processArgs)(first.pid));
        // cwd·명령을 읽는 사이 끝났을 수 있다
        if (this.tracked.get(tabId) !== first.pid) continue;
        this.deps.onStart(tabId, { pid: first.pid, provider: first.provider, cwd, resumeId });
      }
    } finally {
      this.ticking = false;
    }
  }
}
