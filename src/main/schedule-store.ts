// 예약과 실행 이력의 저장. 한 프로세스만 이 파일을 쓴다(단일 writer).
//
// 회차는 보내기 "전에" 기록한다. 보낸 뒤에 적으면 그 사이에 앱이 죽었을 때
// 보냈는지 안 보냈는지 알 길이 없다 — 재시작 뒤 그 회차를 "중단" 으로 남길 수 있어야 한다.
//
// 이력은 예약마다 최근 것만 남긴다. 다만 아직 끝나지 않은 회차는 절대 버리지 않는다 —
// 그게 사라지면 재시작 복구가 그 회차를 못 찾는다.

import fs from "node:fs";
import path from "node:path";
import { isFinalRunStatus, isLiveRun, shouldCoalesceSkip, type Run, type RunStatus, type Schedule } from "@shared/schedules";

/** 예약 하나가 남기는 이력 상한. 넘치면 오래되고 끝난 것부터 버린다. */
export const RUN_HISTORY_MAX = 50;

interface Persisted {
  version: 1;
  schedules: Schedule[];
  runs: Run[];
}

function empty(): Persisted {
  return { version: 1, schedules: [], runs: [] };
}

export class ScheduleStore {
  private readonly file: string;
  private data: Persisted = empty();

  constructor(dir: string) {
    this.file = path.join(dir, "schedules.json");
    this.data = this.read();
  }

  private read(): Persisted {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!raw || typeof raw !== "object") return empty();
      const p = raw as Partial<Persisted>;
      if (p.version !== 1 || !Array.isArray(p.schedules) || !Array.isArray(p.runs)) return empty();
      return { version: 1, schedules: p.schedules, runs: p.runs };
    } catch {
      // 없거나 깨졌으면 빈 상태로 시작한다. 예약은 사용자가 다시 만들 수 있지만,
      // 여기서 죽으면 앱이 안 뜬다.
      return empty();
    }
  }

  /** 통째로 갈아 끼운다. 반쯤 쓰다 죽어도 옛 파일이 남도록 임시 파일에 쓰고 옮긴다. */
  private write(): void {
    const tmp = `${this.file}.tmp`;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.data), "utf8");
      fs.renameSync(tmp, this.file);
    } catch (e) {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        /* 없으면 그만 */
      }
      // 삼키면 안 된다. "보내기 전에 기록한다" 는 약속이 깨진 채로 실행이 이어지면,
      // 재시작 뒤 그 회차가 아예 없던 일이 된다(보냈는지조차 알 수 없다).
      throw new Error(`예약 기록을 저장하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  schedules(): Schedule[] {
    return this.data.schedules.slice();
  }

  schedule(id: string): Schedule | null {
    return this.data.schedules.find((s) => s.id === id) ?? null;
  }

  upsertSchedule(s: Schedule): void {
    const i = this.data.schedules.findIndex((x) => x.id === s.id);
    if (i === -1) this.data.schedules.push(s);
    else this.data.schedules[i] = s;
    this.write();
  }

  removeSchedule(id: string): void {
    this.data.schedules = this.data.schedules.filter((s) => s.id !== id);
    this.data.runs = this.data.runs.filter((r) => r.scheduleId !== id);
    this.write();
  }

  /** 이 예약의 회차들. 최근 것이 앞. */
  runs(scheduleId: string): Run[] {
    // 예정 시각이 같으면(수동 실행이 연달아 올 때) 나중에 만든 것이 앞. 순서가 갈리면
    // "마지막 회차" 가 호출마다 달라져 겹침 판정이 흔들린다.
    const order = new Map(this.data.runs.map((r, i) => [r.id, i]));
    return this.data.runs
      .filter((r) => r.scheduleId === scheduleId)
      .sort((a, b) => b.scheduledFor - a.scheduledFor || (order.get(b.id) ?? 0) - (order.get(a.id) ?? 0));
  }

  lastRun(scheduleId: string): Run | null {
    return this.runs(scheduleId)[0] ?? null;
  }

  /** 아직 끝나지 않은 회차 전부(모든 예약). 재시작 복구가 이걸로 시작한다. */
  liveRuns(scheduleId?: string): Run[] {
    return this.data.runs.filter((r) => isLiveRun(r) && (scheduleId === undefined || r.scheduleId === scheduleId));
  }

  /** 같은 예정 시각의 회차가 이미 있나. 중복 시작을 막는 열쇠. */
  hasRunFor(scheduleId: string, scheduledFor: number): boolean {
    return this.data.runs.some((r) => r.scheduleId === scheduleId && r.scheduledFor === scheduledFor);
  }

  createRun(run: Run): Run {
    const before = this.data.runs;
    this.data.runs = [...before, run];
    this.prune(run.scheduleId);
    try {
      this.write();
    } catch (e) {
      // 저장에 실패했으면 메모리도 되돌린다. 안 그러면 기록에 없는 회차가 메모리에만 남아
      // 이후 회차를 전부 겹침으로 막는다(디스크가 복구돼도 풀리지 않는다).
      this.data.runs = before;
      throw e;
    }
    return run;
  }

  updateRun(id: string, patch: Partial<Run>): Run | null {
    const i = this.data.runs.findIndex((r) => r.id === id);
    if (i === -1) return null;
    const before = this.data.runs;
    const next = { ...before[i], ...patch };
    this.data.runs = before.map((r, j) => (j === i ? next : r));
    this.prune(next.scheduleId);
    try {
      this.write();
    } catch (e) {
      this.data.runs = before;
      throw e;
    }
    return next;
  }

  /**
   * 건너뜀을 기록한다. 같은 사유가 연달아 오면 새 행을 만들지 않고 마지막 것의 시각만 민다 —
   * 5분마다 도는 예약이 대상을 잃으면 하루 288개의 똑같은 행이 진짜 이력을 밀어낸다.
   * 합쳤으면 true.
   */
  recordSkip(input: { scheduleId: string; scheduledFor: number; status: RunStatus; reason: string; make: () => Run }): {
    run: Run;
    coalesced: boolean;
  } {
    const last = this.lastRun(input.scheduleId);
    if (shouldCoalesceSkip(last, input.status, input.reason) && last) {
      const run = this.updateRun(last.id, { scheduledFor: input.scheduledFor, endedAt: Date.now() });
      return { run: run ?? last, coalesced: true };
    }
    return { run: this.createRun(input.make()), coalesced: false };
  }

  /**
   * 앱이 살아 있는 동안 끝을 못 본 회차를 정리한다. 재시작 직후에 부른다.
   * 성공으로 바꾸지 않는다 — 보냈는지도 확신할 수 없는 회차가 섞여 있다.
   */
  reconcileOnStart(reason: string): Run[] {
    const stranded = this.liveRuns();
    for (const r of stranded) {
      this.updateRun(r.id, { status: "interrupted", endedAt: Date.now(), reason });
    }
    return stranded;
  }

  /** 오래된 것부터 버린다. 아직 끝나지 않은 회차는 남긴다 — 복구가 그걸 찾아야 한다. */
  private prune(scheduleId: string): void {
    const mine = this.data.runs.filter((r) => r.scheduleId === scheduleId);
    if (mine.length <= RUN_HISTORY_MAX) return;
    const finished = mine.filter((r) => isFinalRunStatus(r.status)).sort((a, b) => a.scheduledFor - b.scheduledFor);
    const drop = new Set(finished.slice(0, mine.length - RUN_HISTORY_MAX).map((r) => r.id));
    if (drop.size === 0) return;
    this.data.runs = this.data.runs.filter((r) => !drop.has(r.id));
  }
}
