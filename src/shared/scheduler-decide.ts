// 스케줄러가 매 틱에 내리는 결정. 부수효과 없이 "이 회차를 어떻게 할까" 만 답한다.
//
// 실제 실행(세션 만들기·프롬프트 보내기·precheck 돌리기)은 main 이 한다. 여기서 정하는 것은
// 순서와 이유뿐이다 — 그래야 "왜 안 돌았나" 를 시험으로 고정할 수 있다.
//
// 결정 순서가 곧 정책이다. 앞의 것이 뒤의 것을 가린다:
//   꺼짐 → 아직 시각 아님 → 유예 초과 → 겹침 → 대상 없음 → 예산 초과 → 실행
// 유예 초과를 겹침보다 먼저 보는 이유: 앱이 꺼져 있던 회차는 앞 회차가 살아 있든 말든 이미 늦었다.

import type { TFunction } from "i18next";
import type { Msg } from "./i18n/msg";
import { missedBeyondGrace, runReason, type Run, type RunReason, type Schedule } from "./schedules";

export type TickDecision =
  /** 지금은 아무것도 안 한다(다음 시각이 아직 안 됐거나 꺼져 있다). */
  | { kind: "idle" }
  /** 이 회차는 건너뛴다. 기록에 사유를 남긴다. */
  | { kind: "skip"; scheduledFor: number; status: "skipped_missed" | "skipped_overlap" | "skipped_unavailable"; reason: string; reasonMsg: Msg }
  /** precheck 부터 돌린다. 통과하면 dispatch 로 이어진다. */
  | { kind: "precheck"; scheduledFor: number }
  /** 바로 실행한다. */
  | { kind: "dispatch"; scheduledFor: number };

export interface TickInput {
  schedule: Schedule;
  /** 이 예약의 다음 예정 시각(cron 으로 계산해 넘긴다). 없으면(= 일어나지 않는 일정) idle. */
  dueAt: number | null;
  now: number;
  tickMs: number;
  /** 아직 끝나지 않은 이 예약의 회차. 하나라도 있으면 겹침이다. */
  liveRuns: Run[];
  /** 대상이 지금 실행 가능한가. 없으면 사유를 담는다(탭이 사라짐·경로 없음 등). */
  targetUnavailable: RunReason | null;
  /** 예산을 넘겼으면 사유. 실행 직전에 다시 확인해야 한다. */
  budgetBlocked: RunReason | null;
}

export function decideTick(t: TFunction, input: TickInput): TickDecision {
  const { schedule, dueAt, now } = input;
  if (!schedule.enabled || dueAt === null) return { kind: "idle" };
  // 켜진 시점 이전의 회차는 만회하지 않는다.
  if (dueAt < schedule.activeSince) return { kind: "idle" };
  if (now < dueAt) return { kind: "idle" };

  if (missedBeyondGrace({ schedule, scheduledFor: dueAt, now, tickMs: input.tickMs })) {
    return {
      kind: "skip",
      scheduledFor: dueAt,
      status: "skipped_missed",
      ...runReason(t, "schedules.msg.missedGrace"),
    };
  }
  if (input.liveRuns.length > 0) {
    return {
      kind: "skip",
      scheduledFor: dueAt,
      status: "skipped_overlap",
      ...runReason(t, "schedules.msg.overlap"),
    };
  }
  if (input.targetUnavailable) {
    return { kind: "skip", scheduledFor: dueAt, status: "skipped_unavailable", ...input.targetUnavailable };
  }
  if (input.budgetBlocked) {
    return { kind: "skip", scheduledFor: dueAt, status: "skipped_unavailable", ...input.budgetBlocked };
  }
  return schedule.precheck ? { kind: "precheck", scheduledFor: dueAt } : { kind: "dispatch", scheduledFor: dueAt };
}

/**
 * precheck 결과를 어떻게 읽나. "0 이 아니면 전부 건너뜀" 으로 뭉뚱그리면
 * "변경 없음" 과 "인증 만료"·"명령 없음" 이 똑같이 조용히 사라진다.
 */
export type PrecheckVerdict =
  | { kind: "run" }
  | ({ kind: "skip" } & RunReason)
  | ({ kind: "failed" } & RunReason);

export function readPrecheck(t: TFunction, r: { exitCode: number | null; timedOut: boolean; error: string | null }): PrecheckVerdict {
  if (r.timedOut) return { kind: "failed", ...runReason(t, "schedules.msg.precheckTimeout") };
  if (r.error) return { kind: "failed", ...runReason(t, "schedules.msg.precheckSpawnFailed", { detail: r.error }) };
  if (r.exitCode === 0) return { kind: "run" };
  if (r.exitCode === null) return { kind: "failed", ...runReason(t, "schedules.msg.precheckNoExit") };
  // 1 은 "조건 불충족" 의 관례다. 그 밖의 코드는 명령이 고장 났을 가능성이 크다.
  if (r.exitCode === 1) return { kind: "skip", ...runReason(t, "schedules.msg.precheckNothingToDo") };
  return { kind: "failed", ...runReason(t, "schedules.msg.precheckExit", { code: r.exitCode }) };
}
