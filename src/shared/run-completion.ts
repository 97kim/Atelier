// "예약 회차가 끝났나" 를 판정한다. 순수 상태 기계 — 신호를 받아 판정만 내린다.
//
// 이 규칙은 추측이 아니라 실측에서 나왔다(WORKBENCH_DEBUG_SDK 로 잡은 순서):
//
//   정상(백그라운드 후속 턴 있음)
//     tasks=1 → result(첫 턴) → tasks=0(sdk) → task_notification → 새 턴 → result → 끝
//   정상(단순)
//     result → 끝 (프로세스는 살아 있다. 스트림은 안 끝난다)
//   크래시
//     result → 스트림이 예외로 끝남("terminated by signal SIGKILL") → tasks=0(cleanup)
//
// 두 가지를 섞지 않는 것이 핵심이다.
//   1) 빈 작업 목록의 출처. 프로세스가 죽어 우리가 비운 목록(cleanup)은 "일이 끝났다" 가 아니라
//      "더는 모른다" 는 뜻이다. 이걸 근거로 쓰면 크래시가 성공이 된다.
//   2) 첫 result 는 끝이 아니다. 백그라운드가 남아 있으면 CLI 가 스스로 이어서 또 턴을 돈다.
//
// 오르카도 같은 태도다 — 관찰을 잃으면 절대 완료라고 하지 않고 사유를 남긴다.

/** 판정에 쓰는 신호. 어댑터가 보는 것을 그대로 옮긴 것만 둔다. */
export type RunSignal =
  /** 턴 하나가 끝났다(SDK result). 회차의 끝이라는 뜻은 아니다. */
  | { kind: "result"; isError: boolean }
  /** 살아 있는 백그라운드 작업 전체 집합이 바뀌었다. source 가 판정을 가른다. */
  | { kind: "tasks"; count: number; source: "sdk" | "cleanup" }
  /** 새 턴이 시작됐다(우리가 보낸 것이든, CLI 가 스스로 이어간 것이든). */
  | { kind: "turn_started" }
  /** 사용자 응답을 기다리는 요청 수(권한·질문). */
  | { kind: "awaiting"; count: number }
  /** 스트림이 끝났다. expected = 우리가 의도적으로 닫았다(탭 닫기·유휴 종료 등). */
  | { kind: "stream_ended"; reason: string; expected: boolean };

export interface RunState {
  sawResult: boolean;
  resultIsError: boolean;
  /**
   * SDK 가 알려 준 살아 있는 작업 수. null = 한 번도 안 왔다 = 작업이 없다.
   * SDK 는 집합이 바뀔 때만 보내므로 "온 적 없음" 은 "없음" 이다(실측: 단순 턴에는 아예 안 온다).
   * cleanup 출처는 이 값을 건드리지 않는다.
   */
  liveTasks: number | null;
  awaiting: number;
  ended: { reason: string; expected: boolean } | null;
}

export type RunVerdict =
  | { state: "running" }
  /** 사람이 답해야 진행된다. 무인 실행에서는 그대로 두면 영영 멈춘다. */
  | { state: "needs_action" }
  | { state: "completed"; isError: boolean }
  /** 끝났는지 알 수 없게 됐다. 성공으로 바꾸지 않는다. */
  | { state: "interrupted"; reason: string };

export function newRunState(): RunState {
  return { sawResult: false, resultIsError: false, liveTasks: null, awaiting: 0, ended: null };
}

export function applyRunSignal(s: RunState, sig: RunSignal): RunState {
  switch (sig.kind) {
    case "result":
      return { ...s, sawResult: true, resultIsError: sig.isError };
    case "tasks":
      // cleanup 이 만든 목록은 판정 근거가 아니다 — 프로세스가 죽었다는 뜻일 뿐이다.
      return sig.source === "cleanup" ? s : { ...s, liveTasks: sig.count };
    case "turn_started":
      // 후속 턴이 시작됐다. 앞 턴의 result 는 더 이상 "끝" 의 후보가 아니다.
      return { ...s, sawResult: false, resultIsError: false };
    case "awaiting":
      return { ...s, awaiting: Math.max(0, sig.count) };
    case "stream_ended":
      return { ...s, ended: { reason: sig.reason, expected: sig.expected } };
  }
}

export function runVerdict(s: RunState): RunVerdict {
  // 스트림이 끝났으면 그때까지의 상태와 무관하게 "모른다" 다. 다만 끝까지 갔다면 완료로 본다.
  if (s.ended) {
    if (s.sawResult && (s.liveTasks ?? 0) === 0 && s.awaiting === 0) return { state: "completed", isError: s.resultIsError };
    return { state: "interrupted", reason: s.ended.reason };
  }
  if (s.awaiting > 0) return { state: "needs_action" };
  if (!s.sawResult) return { state: "running" };
  // result 는 받았지만 백그라운드가 남았다 — CLI 가 곧 이어서 또 턴을 돈다.
  if ((s.liveTasks ?? 0) > 0) return { state: "running" };
  return { state: "completed", isError: s.resultIsError };
}

/** 신호를 순서대로 먹여 판정한다(시험·재생용). */
export function judgeRun(signals: RunSignal[]): RunVerdict {
  return runVerdict(signals.reduce(applyRunSignal, newRunState()));
}
