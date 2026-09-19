// 설정 > 예약. 목록·다음 실행 시각·최근 결과를 보여 주고, 켜기/끄기·지금 실행·삭제를 한다.
//
// 만들기는 CLI 가 맡는다(`atelier schedule add`). 화면에서 프롬프트·cron·대상·권한을 다 받으려면
// 폼이 커지는데, 그 폼을 먼저 만들면 정작 중요한 "무엇이 언제 돌았나" 가 뒤로 밀린다.

import { useEffect, useState } from "react";
import type { ScheduleListDto } from "@shared/ipc";
import { classify } from "@shared/cron";
import type { Run, RunStatus } from "@shared/schedules";
import { Icon } from "./Icon";

const STATUS_LABEL: Record<RunStatus, string> = {
  pending: "시작하는 중",
  running: "도는 중",
  needs_action: "승인 대기",
  completed: "완료",
  failed: "실패",
  skipped_precheck: "건너뜀 · 할 일 없음",
  skipped_missed: "건너뜀 · 시각 놓침",
  skipped_unavailable: "건너뜀 · 실행 불가",
  skipped_overlap: "건너뜀 · 앞 회차가 진행 중",
  interrupted: "중단 · 끝을 확인 못 함",
};

const STATUS_TONE: Record<RunStatus, string> = {
  pending: "text-muted",
  running: "text-accent",
  needs_action: "text-warn",
  completed: "text-ok",
  failed: "text-err",
  skipped_precheck: "text-muted",
  skipped_missed: "text-muted",
  skipped_unavailable: "text-muted",
  skipped_overlap: "text-muted",
  interrupted: "text-warn",
};

const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

/** cron 을 사람 말로. 프리셋이 아니면 식을 그대로 보여 준다 — 거짓말하지 않는다. */
function scheduleLabel(cron: string): string {
  const p = classify(cron);
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  switch (p.kind) {
    case "hourly":
      return `매시 ${String(p.minute).padStart(2, "0")}분`;
    case "daily":
      return `매일 ${hhmm(p.hour, p.minute)}`;
    case "weekdays":
      return `평일 ${hhmm(p.hour, p.minute)}`;
    case "weekly":
      return `매주 ${WEEKDAYS[p.dayOfWeek] ?? "?"} ${hhmm(p.hour, p.minute)}`;
    case "invalid":
      return `읽을 수 없는 일정 (${cron})`;
    default:
      return cron;
  }
}

function when(ms: number | null): string {
  if (!ms) return "—";
  const d = new Date(ms);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  const time = d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" });
  return sameDay ? `오늘 ${time}` : `${d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" })} ${time}`;
}

export function SchedulesSection() {
  const [data, setData] = useState<ScheduleListDto>({ schedules: [], runs: [] });
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    void window.workbench.schedules.list().then((d) => alive && setData(d));
    const off = window.workbench.schedules.onChanged((d) => setData(d));
    return () => {
      alive = false;
      off();
    };
  }, []);

  const act = async (id: string, fn: () => Promise<ScheduleListDto>) => {
    setBusy(id);
    try {
      setData(await fn());
    } finally {
      setBusy(null);
    }
  };

  return (
    <div data-schedules-section>
      <div className="mb-5">
        <h1 className="text-[20px] font-semibold">예약</h1>
        <p className="mt-1 text-muted">정해진 시각에 프롬프트를 보냅니다. 회차마다 결과가 남습니다.</p>
      </div>

      {data.schedules.length === 0 ? (
        <div className="rounded-lg border border-line bg-panel px-4 py-6 text-muted">
          <p>아직 예약이 없습니다.</p>
          <p className="mt-2 text-[12px] text-muted-2">
            터미널에서 만듭니다:
            <code className="mono ml-1">atelier schedule add --name 아침점검 --cron "30 9 * * *" --prompt "…" --ws repo</code>
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {data.schedules.map((s) => {
            const last: Run | undefined = data.runs.find((r) => r.scheduleId === s.id);
            return (
              <li key={s.id} className="rounded-lg border border-line bg-panel px-4 py-3" data-schedule={s.id}>
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className={`font-medium ${s.enabled ? "text-fg" : "text-muted"}`}>{s.name}</span>
                      {!s.enabled && <span className="label text-muted-2">꺼짐</span>}
                      {s.target.kind === "fresh" && s.target.worktree && <span className="label text-muted-2">격리 세션</span>}
                    </div>
                    <div className="mono mt-1 text-[11px] text-muted">
                      {scheduleLabel(s.cron)} · {s.timezone} · 다음 {when(s.nextRunAt)}
                    </div>
                    <div className="mt-1 truncate text-[12px] text-muted-2">{s.prompt}</div>
                    {last && (
                      <div className="mt-2 flex items-center gap-2 text-[11px]" data-last-run={last.status}>
                        <span className={STATUS_TONE[last.status]}>{STATUS_LABEL[last.status]}</span>
                        <span className="mono text-muted-2">{when(last.endedAt ?? last.startedAt ?? last.scheduledFor)}</span>
                        {last.reason && <span className="min-w-0 flex-1 truncate text-muted-2">{last.reason}</span>}
                      </div>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <button
                      onClick={() => void act(s.id, () => window.workbench.schedules.runNow(s.id))}
                      disabled={busy === s.id}
                      title="지금 한 번 실행"
                      className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50"
                    >
                      <Icon name="play" size={13} />
                    </button>
                    <button
                      onClick={() => void act(s.id, () => window.workbench.schedules.save({ id: s.id, enabled: !s.enabled }))}
                      disabled={busy === s.id}
                      title={s.enabled ? "끄기" : "켜기"}
                      className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-50"
                    >
                      {s.enabled ? "끄기" : "켜기"}
                    </button>
                    <button
                      onClick={() => void act(s.id, () => window.workbench.schedules.remove(s.id))}
                      disabled={busy === s.id}
                      title="예약과 이력을 지웁니다"
                      className="rounded-md p-1.5 text-muted hover:bg-err/10 hover:text-err disabled:opacity-50"
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </div>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
