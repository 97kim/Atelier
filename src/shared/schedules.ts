// 예약(Schedule)과 그 실행 회차(Run)의 자료 모델. 순수 — 저장·타이머는 main 이 맡는다.
//
// 상태를 성공/실패 둘로 두지 않는다. "안 돌았다" 의 이유가 서로 다르고, 그 이유가 곧 사용자가
// 알아야 할 정보다(오르카도 건너뜀을 이유별로 넷으로 나눈다).
//
// 회차는 보내기 "전에" 기록한다. 보낸 뒤에 기록하면 그 사이에 앱이 죽었을 때
// 보냈는지 안 보냈는지 알 길이 없다.

import type { PermissionPolicy } from "./chat-events";
import type { ProviderId } from "./workspace-model";

/**
 * 실행 대상. v1 은 회차마다 새 세션뿐이다.
 *
 * "정해 둔 탭에 보내기" 는 뺐다. 그 탭이 바쁘면 프롬프트가 대기열에 들어가는데, 그러면
 *   - 사용자 턴의 result 로 예약 회차가 완료 처리되고(감시는 탭 단위다),
 *   - 예약의 권한이 진행 중인 사용자 작업에 적용되고,
 *   - 재시작 뒤 대기열에 남아 있던 예약이 나중에 혼자 되살아난다.
 * 셋 다 사용자의 작업을 건드리는 사고다. 이어쓰기가 필요하면 그때 제대로 설계한다.
 */
export type ScheduleTarget = { kind: "fresh"; workspaceId: string; worktree: boolean };

export interface SchedulePrecheck {
  /** 셸 명령 하나. 종료코드 0 이면 실행하고, 0 이 아니면 그 회차를 건너뛴다. */
  command: string;
  /** 이 시간을 넘기면 죽이고 실패로 본다(조건 불충족과 구분한다). */
  timeoutMs: number;
}

export interface Schedule {
  id: string;
  name: string;
  /** 5칸 cron. 프리셋은 이 문자열을 되읽어 붙이는 이름일 뿐이다. */
  cron: string;
  /** IANA 이름. 맥의 시간대가 바뀌어도 예약은 안 움직인다. */
  timezone: string;
  prompt: string;
  provider: ProviderId;
  model?: string;
  /**
   * 이 예약이 쓸 권한. 탭 설정을 따라가지 않는다 — 낮에 탭을 "전부 자동" 으로 바꿨다고
   * 새벽 예약의 권한까지 올라가면 안 된다. 만들 때 탭 값을 복사해 올 뿐이다.
   */
  policy: PermissionPolicy;
  target: ScheduleTarget;
  precheck?: SchedulePrecheck;
  enabled: boolean;
  /** 예정 시각을 이만큼 넘겨 깨어났으면 그 회차는 건너뛴다. */
  missedRunGraceMinutes: number;
  createdAt: number;
  /** 이 시각 이후의 회차만 센다. 새로 만들거나 다시 켠 시점 — 과거를 만회하지 않는다. */
  activeSince: number;
}

export type RunStatus =
  /** 실행하기로 정하고 기록만 해 둔 상태(보내기 직전). */
  | "pending"
  /** 세션에 보냈다. 아직 끝나지 않았다. */
  | "running"
  /** 사람의 승인·답을 기다린다. 무인 실행에서는 여기서 멈춘다. */
  | "needs_action"
  | "completed"
  /** 모델이 오류로 끝냈다(턴은 끝났다). */
  | "failed"
  /** precheck 가 "지금은 할 일 없음" 이라고 했다. */
  | "skipped_precheck"
  /** 유예를 넘겨 깨어났다. */
  | "skipped_missed"
  /** 대상이 사라졌거나 지금 실행할 수 없다(탭 없음·경로 없음·예산 초과). */
  | "skipped_unavailable"
  /** 겹친다 — 앞 회차가 아직 안 끝났다. */
  | "skipped_overlap"
  /** 보냈지만 끝을 확인하지 못했다(앱 종료·크래시). 성공으로 바꾸지 않는다. */
  | "interrupted";

/** 더는 변하지 않는 상태. 이력에서 지워도 되는 것은 이것뿐이다. */
export function isFinalRunStatus(s: RunStatus): boolean {
  return (
    s === "completed" ||
    s === "failed" ||
    s === "interrupted" ||
    s === "skipped_precheck" ||
    s === "skipped_missed" ||
    s === "skipped_unavailable" ||
    s === "skipped_overlap"
  );
}

export interface PrecheckResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  /** 꼬리만. 통째로 두면 이력 파일이 커진다. */
  stdout: string;
  stderr: string;
  /** 명령 자체를 못 돌렸다(없는 명령 등). 조건 불충족과 다르다. */
  error: string | null;
}

export interface Run {
  id: string;
  scheduleId: string;
  /** 예정 시각. 같은 예약의 같은 회차를 두 번 만들지 않는 열쇠다. */
  scheduledFor: number;
  trigger: "scheduled" | "manual";
  status: RunStatus;
  /** 그때의 설정 스냅샷. 예약을 나중에 고쳐도 지난 회차의 기록은 그대로여야 한다. */
  snapshot: { prompt: string; cron: string; timezone: string; policy: PermissionPolicy; provider: ProviderId; target: ScheduleTarget };
  startedAt: number | null;
  endedAt: number | null;
  /** 실제로 돌아간 탭. 이력에서 그 대화를 열 수 있게. */
  tabId: string | null;
  precheck?: PrecheckResult;
  /** 사람이 읽을 사유. 건너뜀·중단이면 반드시 채운다. */
  reason: string | null;
}

/** 이 예약의 회차 하나를 가리키는 안정된 열쇠. 중복 시작을 막는다. */
export function runKey(scheduleId: string, scheduledFor: number): string {
  return `${scheduleId}@${scheduledFor}`;
}

/** 아직 끝나지 않은 회차. 하나라도 있으면 다음 회차는 겹침으로 건너뛴다. */
export function isLiveRun(r: Run): boolean {
  return !isFinalRunStatus(r.status);
}

/**
 * 예정 시각을 얼마나 넘겼으면 포기하나. 유예에 "틱 두 개" 를 더한다 —
 * 스케줄러가 조금 늦은 것과 앱이 꺼져 있던 것은 다른 일이다(오르카도 같은 보정을 한다).
 */
export function missedBeyondGrace(input: { schedule: Schedule; scheduledFor: number; now: number; tickMs: number }): boolean {
  const graceMs = Math.max(0, input.schedule.missedRunGraceMinutes) * 60_000;
  return input.now - input.scheduledFor > graceMs + input.tickMs * 2;
}

/**
 * 같은 사유의 건너뜀이 연달아 쌓이는 것을 막는다. 5분마다 도는 예약이 대상을 잃으면
 * 하루 288개의 똑같은 행이 쌓여 진짜 이력을 밀어낸다 — 마지막 회차가 같은 사유면 갱신만 한다.
 */
export function shouldCoalesceSkip(last: Run | null, status: RunStatus, reason: string | null): boolean {
  if (!last) return false;
  return last.status === status && last.reason === reason && status.startsWith("skipped_");
}
