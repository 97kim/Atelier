// Claude Code 가 백그라운드로 돌리는 일(명령·하위 에이전트 등). 턴은 먼저 끝나고 그 일만 계속 도는데,
// 그동안 탭은 놀고 있는 것처럼 보인다 — 무엇이 도는지도, 끝났는지도 화면에 남지 않았다.
//
// SDK 가 두 가지를 준다. 둘 다 type:"system" 이라 진행 중인 턴이 없어도 온다.
//   background_tasks_changed — 지금 살아 있는 작업 "전체 집합". 받을 때마다 통째로 갈아 끼운다(REPLACE).
//                              시작/끝 신호를 짝지어 세지 않으므로, 하나를 놓쳐도 표시가 남아 돌지 않는다.
//   task_notification        — 하나가 끝났다(completed|failed|stopped).
//
// 한때 이걸 출력 파일 꼬리의 "[exited with code N]" 으로 알아내려 했다. 틀린 방법이었다 —
// 명령이 그 문구를 스스로 찍으면 아직 도는 일을 끝난 것으로 만든다.
//
// ambient 는 CLI 살림용이라 화면에 세지 않는다(SDK 가 그렇게 하라고 표시해 준다).

/** 살아 있는 백그라운드 작업 하나. */
export interface LiveBackgroundTask {
  id: string;
  /** shell · subagent · monitor … 모르는 값이 올 수 있다. */
  type: string;
  description: string;
}

// SDK 가 두 갈래로 준다 — 원본 판별자(local_bash …)와 사람용 이름(shell …). 둘 다 받아 둔다.
const LABEL: Record<string, string> = {
  shell: "명령",
  local_bash: "명령",
  subagent: "하위 에이전트",
  local_agent: "하위 에이전트",
  workflow: "워크플로",
  local_workflow: "워크플로",
  mcp_task: "MCP 작업",
  monitor: "감시",
};

/** 화면에 쓸 종류 이름. 모르는 종류는 온 그대로 보여 준다(숨기는 것보다 낫다). */
export function taskLabel(type: string): string {
  return LABEL[type] ?? (type.trim() || "작업");
}

/** 한 줄로 줄인다. SDK 가 1000자까지 보내므로 목록에 그대로 쓰면 길다. */
export function taskSummary(description: string, max = 120): string {
  const one = description.replace(/\s+/g, " ").trim();
  return one.length > max ? `${one.slice(0, max - 1)}…` : one;
}

/**
 * background_tasks_changed 의 tasks 를 읽는다. 남의 형식이라 모양만 보고, 모르는 항목은 버린다.
 * ambient(살림용)는 여기서 걸러 낸다.
 */
export function parseLiveTasks(raw: unknown): LiveBackgroundTask[] {
  if (!Array.isArray(raw)) return [];
  const out: LiveBackgroundTask[] = [];
  for (const t of raw) {
    if (!t || typeof t !== "object") continue;
    const o = t as Record<string, unknown>;
    const id = typeof o.task_id === "string" ? o.task_id : "";
    if (!id) continue;
    if (o.ambient === true) continue;
    out.push({
      id,
      type: typeof o.task_type === "string" ? o.task_type : "",
      description: typeof o.description === "string" ? o.description : "",
    });
  }
  return out;
}

/** 끝났다는 알림. status 를 우리 쪽 성공/실패로 옮긴다 — stopped 는 사용자가 세운 것이라 실패가 아니다. */
export interface TaskFinishedNote {
  id: string;
  status: "completed" | "failed" | "stopped";
  summary: string;
}

export function parseTaskFinished(raw: unknown): TaskFinishedNote | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.task_id === "string" ? o.task_id : "";
  const status = o.status;
  if (!id) return null;
  if (o.ambient === true) return null;
  if (status !== "completed" && status !== "failed" && status !== "stopped") return null;
  return { id, status, summary: typeof o.summary === "string" ? taskSummary(o.summary) : "" };
}
