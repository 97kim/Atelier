// 탭의 턴이 끝난 뒤에도 계속 도는 작업(지금은 Codex 플러그인의 백그라운드 rescue).
// 턴에 묶인 하위 에이전트 미러와 달리 프로세스가 앱에서 떨어져 나가므로, 플러그인이 디스크에 쓰는 작업 목록을 읽어서 보여 준다.

export type BackgroundJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundJobDto {
  id: string;
  /** 어느 대화의 작업인지 — provider 세션 id. 탭과 잇는 열쇠. */
  sessionId: string;
  /** 화면에 쓸 종류 이름 ("rescue" 등). */
  label: string;
  title: string;
  status: BackgroundJobStatus;
  /** 지시 앞부분. 무엇을 시켰는지 알아보게. */
  summary: string;
  startedAt: number;
  completedAt: number | null;
  /** 이 작업을 기록한 곳(작업 디렉토리). 같은 id 가 다른 저장소에 있을 수 있다. */
  root: string;
}

export const isActiveJob = (s: BackgroundJobStatus): boolean => s === "queued" || s === "running";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const time = (v: unknown): number | null => {
  const t = typeof v === "string" ? Date.parse(v) : NaN;
  return Number.isFinite(t) ? t : null;
};

const STATUSES: BackgroundJobStatus[] = ["queued", "running", "completed", "failed", "cancelled"];

/**
 * 플러그인 state.json 의 jobs 항목 하나를 읽는다. 우리가 못 읽는 형식이면 null.
 * 남이 쓰는 파일이라 필드가 없거나 형식이 바뀔 수 있다 — 모르는 값은 버리고 읽히는 것만 쓴다.
 */
export function parseBackgroundJob(raw: unknown, root: string): BackgroundJobDto | null {
  if (!raw || typeof raw !== "object") return null;
  const j = raw as Record<string, unknown>;
  const id = str(j.id);
  const sessionId = str(j.sessionId);
  if (!id || !sessionId) return null;
  const status = STATUSES.find((s) => s === j.status);
  if (!status) return null;
  const started = time(j.startedAt) ?? time(j.createdAt);
  if (started === null) return null;
  return {
    id,
    sessionId,
    label: str(j.kindLabel) || str(j.kind) || "작업",
    title: str(j.title) || "백그라운드 작업",
    status,
    summary: str(j.summary).replace(/\s+/g, " ").trim().slice(0, 200),
    startedAt: started,
    completedAt: time(j.completedAt),
    root,
  };
}

/** 저장소+id 가 같으면 한 작업. 나중에 읽은(더 늦게 시작한) 쪽을 남기고 시작 순으로 정렬한다. */
export function mergeJobs(jobs: BackgroundJobDto[]): BackgroundJobDto[] {
  const by = new Map<string, BackgroundJobDto>();
  for (const j of jobs) {
    const key = `${j.root}|${j.id}`;
    const cur = by.get(key);
    if (!cur || j.startedAt >= cur.startedAt) by.set(key, j);
  }
  return [...by.values()].sort((a, b) => a.startedAt - b.startedAt);
}

/** 진행 줄에 쓸 한 줄. "rescue · 3분 12초 경과" */
export function jobElapsed(job: BackgroundJobDto, now: number): string {
  const secs = Math.max(0, Math.floor((now - job.startedAt) / 1000));
  return secs >= 60 ? `${Math.floor(secs / 60)}분 ${secs % 60}초` : `${secs}초`;
}

export function jobRunningLabel(job: BackgroundJobDto, now: number): string {
  return `${job.label} · ${jobElapsed(job, now)} 경과`;
}

/** 여러 개일 때 접어 두는 한 줄. 가장 오래 돈 것을 기준으로 삼는다 — 사람이 궁금한 것은 "얼마나 됐나" 다. */
export function jobsSummaryLabel(jobs: BackgroundJobDto[], now: number): string {
  if (jobs.length === 0) return "";
  const oldest = jobs.reduce((a, j) => (j.startedAt < a.startedAt ? j : a), jobs[0]);
  return `${jobs.length}개 · 가장 오래 ${jobElapsed(oldest, now)} 경과`;
}
