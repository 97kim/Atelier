// Claude Code 가 백그라운드로 돌린 명령(Bash 의 run_in_background). 턴은 먼저 끝나고 명령만 계속 도는데,
// 그동안 탭은 놀고 있는 것처럼 보인다 — 무엇이 도는지도, 끝났는지도 화면에 남지 않는다.
//
// 단서는 둘뿐이고 둘 다 남이 만든 문자열이다:
//   시작 — 툴 결과 문구에 든 작업 id 와 출력 파일 경로
//   끝   — 그 출력 파일 끝에 붙는 "[exited with code N]"
// 문구가 바뀌면 못 읽는다. 그때는 표시가 안 뜰 뿐 대화는 그대로다(기능만 조용히 꺼진다).

/** 백그라운드로 넘어간 명령 하나의 단서. */
export interface BashBackgroundStart {
  id: string;
  /** 출력이 쌓이는 파일. 끝났는지 알 수 있는 유일한 곳. */
  file: string;
}

// "Command running in background with ID: b0n6… . Output is being written to: /private/tmp/…/b0n6….output. You will be…"
const START_RE = /running in background with ID:\s*([A-Za-z0-9_-]+)[\s\S]*?written to:\s*(\/\S+\.output)/;

export function parseBashBackgroundStart(output: string): BashBackgroundStart | null {
  const m = START_RE.exec(output);
  return m ? { id: m[1], file: m[2] } : null;
}

const EXIT_RE = /\[exited with code (-?\d+)\]$/;

/** 출력 꼬리에서 끝난 코드를 읽는다. 아직 돌고 있으면 null. */
export function parseBashExitCode(tail: string): number | null {
  const m = EXIT_RE.exec(tail.trimEnd());
  return m ? Number(m[1]) : null;
}

/** 목록에 쓸 한 줄. 여러 줄짜리 명령은 공백으로 붙이고 길면 자른다. */
export function bashJobSummary(command: string, max = 120): string {
  const one = command.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * 이 툴 호출이 백그라운드 Bash 인가. 맞으면 명령 문자열(없으면 빈 문자열), 아니면 null.
 * 남의 스키마라 필드 모양만 본다.
 */
export function backgroundBashCommand(name: string, input: unknown): string | null {
  if (name !== "Bash" || !input || typeof input !== "object") return null;
  const i = input as { command?: unknown; run_in_background?: unknown };
  if (i.run_in_background !== true) return null;
  return typeof i.command === "string" ? i.command : "";
}
