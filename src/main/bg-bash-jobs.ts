// Claude Code 가 백그라운드로 돌린 명령을 지켜본다. 턴이 먼저 끝나 탭은 놀고 있는 것처럼 보이지만 명령은 계속 돈다.
//
// 플러그인 작업(background-jobs.ts)과 달리 목록 파일이 없다. 대신 대화 이벤트로 시작을 알고,
// 툴 결과가 알려 준 출력 파일의 꼬리를 보고 끝을 안다. 표시는 같은 줄에 합류시킨다 —
// 사용자에겐 "아직 도는 일" 이 한 종류다.
//
// 결과는 다음 메시지를 보낼 때 대화에 딸려 온다(끝났다고 탭이 저절로 이어서 말하지 않는다).
// 그래서 "끝났다" 를 보여 주는 일이 더 중요하다 — 그걸 알아야 말을 걸어 결과를 받는다.

import fs from "node:fs";
import { backgroundBashCommand, bashJobSummary, parseBashBackgroundStart, parseBashExitCode } from "@shared/bg-bash";
import type { BackgroundJobDto } from "@shared/background-jobs";
import type { BackgroundJobsEvents } from "./background-jobs";

const POLL_MS = 2000;
/** 파일 끝만 읽는다 — 빌드 로그는 수 MB 가 되기도 한다. */
const TAIL_BYTES = 512;
/** 끝 표시가 끝내 안 붙는 경우(파일이 지워짐·CLI 가 죽음) 목록에 영원히 남지 않게. */
const MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 짝이 안 맞는 tool_use 가 쌓이지 않게. */
const PENDING_MAX = 64;

interface Entry {
  job: BackgroundJobDto;
  file: string;
}

export class BashJobWatcher {
  /** 백그라운드로 보이는 tool_use — 짝이 되는 tool_result 가 오면 등록한다. */
  private pending = new Map<string, string>();
  private entries = new Map<string, Entry>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly events: BackgroundJobsEvents) {}

  /** 지금 도는 명령들. */
  current(): BackgroundJobDto[] {
    return [...this.entries.values()].map((e) => e.job);
  }

  noteToolUse(toolUseId: string, name: string, input: unknown): void {
    const cmd = backgroundBashCommand(name, input);
    if (cmd === null) return;
    this.pending.set(toolUseId, cmd);
    if (this.pending.size > PENDING_MAX) this.pending.delete(this.pending.keys().next().value as string);
  }

  /** 이 툴 호출이 백그라운드로 넘어갈 후보인가(툴 결과마다 세션을 뒤지지 않게). */
  hasPending(toolUseId: string): boolean {
    return this.pending.has(toolUseId);
  }

  noteToolResult(toolUseId: string, output: string, sessionId: string | null, cwd: string | null): void {
    const cmd = this.pending.get(toolUseId);
    if (cmd === undefined) return;
    this.pending.delete(toolUseId);
    // 어느 대화의 일인지 못 이으면 보여 줄 곳이 없다. 백그라운드로 안 넘어갔으면(거부·오류) 문구가 없다.
    const start = sessionId ? parseBashBackgroundStart(output) : null;
    if (!start) return;
    const summary = bashJobSummary(cmd);
    this.entries.set(start.id, {
      file: start.file,
      job: {
        id: start.id,
        sessionId: sessionId as string,
        label: "명령",
        title: summary || "백그라운드 명령",
        status: "running",
        summary,
        startedAt: Date.now(),
        completedAt: null,
        root: cwd ?? "",
      },
    });
    this.events.onChanged(this.current());
    this.arm();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private arm(): void {
    if (this.timer || this.entries.size === 0) return;
    this.timer = setInterval(() => this.sweep(), POLL_MS);
  }

  private sweep(): void {
    const now = Date.now();
    let changed = false;
    for (const [id, e] of [...this.entries]) {
      const code = exitCodeOf(e.file);
      if (code === null) {
        // 끝 표시가 안 붙은 채 너무 오래된 것은 조용히 놓아 준다(끝났다고 알리지는 않는다 — 모르는 일이다).
        if (now - e.job.startedAt > MAX_AGE_MS) {
          this.entries.delete(id);
          changed = true;
        }
        continue;
      }
      this.entries.delete(id);
      changed = true;
      this.events.onFinished({ ...e.job, status: code === 0 ? "completed" : "failed", completedAt: now });
    }
    if (changed) this.events.onChanged(this.current());
    if (this.entries.size === 0) this.stop();
  }
}

/** 파일 꼬리에서 끝난 코드를 읽는다. 아직 없거나 못 읽으면 "도는 중" 으로 본다. */
function exitCodeOf(file: string): number | null {
  let fd: number | null = null;
  try {
    const size = fs.statSync(file).size;
    const len = Math.min(TAIL_BYTES, size);
    if (len === 0) return null;
    fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    return parseBashExitCode(buf.toString("utf8"));
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* 이미 닫힘 */
      }
    }
  }
}
