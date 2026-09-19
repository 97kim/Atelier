// 설정 > 예약. 목록·다음 실행 시각·최근 결과를 보여 주고, 만들기·고치기·켜기/끄기·지금 실행·삭제를 한다.
//
// 폼은 프리셋(매시·매일·평일·매주)을 먼저 보여 주고 cron 은 "직접" 을 골랐을 때만 드러낸다.
// 대부분의 예약은 네 가지 중 하나인데, 그걸 위해 cron 을 배우게 할 이유가 없다.
// 저장 전에 다음 실행 시각을 계산해 보여 준다 — 사용자가 고른 것이 정말 언제 도는지 확인하는 자리다.

import { useEffect, useMemo, useState } from "react";
import type { ScheduleListDto } from "@shared/ipc";
import type { PermissionPolicy } from "@shared/chat-events";
import type { ProviderId } from "@shared/workspace-model";
import { classify, nextOccurrence, parseCron, presetToCron } from "@shared/cron";
import type { Run, RunStatus, Schedule } from "@shared/schedules";
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

const POLICY_LABEL: Record<PermissionPolicy, string> = {
  ask: "물어보기",
  auto_edit: "편집은 자동",
  full: "전부 자동",
};

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

type Repeat = "hourly" | "daily" | "weekdays" | "weekly" | "custom";

interface Draft {
  id?: string;
  name: string;
  repeat: Repeat;
  /** 매시일 때 쓰는 분. */
  minute: number;
  /** 나머지 프리셋이 쓰는 시각(HH:MM). */
  time: string;
  dayOfWeek: number;
  /** "직접" 을 골랐을 때만 쓴다. */
  cron: string;
  timezone: string;
  prompt: string;
  provider: ProviderId;
  policy: PermissionPolicy;
  workspaceId: string;
  worktree: boolean;
}

const field = "w-full rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent/50";

/**
 * 사람에게 보일 오류 문구. Electron 은 IPC 오류 앞에 "Invoking remote method …" 배관을 붙이는데,
 * 그대로 두면 "이름을 적어 주세요" 같은 안내가 내부 채널 이름에 파묻힌다.
 */
function humanError(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  return raw.replace(/^Error invoking remote method '[^']*':\s*/, "").replace(/^Error:\s*/, "").trim();
}

function blankDraft(workspaceId: string): Draft {
  return {
    name: "",
    repeat: "daily",
    minute: 0,
    time: "09:00",
    dayOfWeek: 1,
    cron: "0 9 * * *",
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    prompt: "",
    provider: "claude",
    policy: "ask",
    workspaceId,
    worktree: false,
  };
}

/** 저장된 예약을 폼 값으로 되읽는다. 프리셋이 아니면 "직접" 으로 열어 식을 그대로 보여 준다. */
function toDraft(s: Schedule): Draft {
  const p = classify(s.cron);
  const base = { ...blankDraft(s.target.workspaceId) };
  const hhmm = (h: number, m: number) => `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
  const when: Partial<Draft> =
    p.kind === "hourly"
      ? { repeat: "hourly", minute: p.minute }
      : p.kind === "daily"
        ? { repeat: "daily", time: hhmm(p.hour, p.minute) }
        : p.kind === "weekdays"
          ? { repeat: "weekdays", time: hhmm(p.hour, p.minute) }
          : p.kind === "weekly"
            ? { repeat: "weekly", time: hhmm(p.hour, p.minute), dayOfWeek: p.dayOfWeek }
            : { repeat: "custom" };
  return {
    ...base,
    ...when,
    id: s.id,
    name: s.name,
    cron: s.cron,
    timezone: s.timezone,
    prompt: s.prompt,
    provider: s.provider,
    policy: s.policy,
    workspaceId: s.target.workspaceId,
    worktree: s.target.worktree,
  };
}

/** 폼 값 → cron. "직접" 이면 적은 것을 그대로 쓴다. */
function draftCron(d: Draft): string {
  const [h, m] = d.time.split(":").map((x) => Number(x));
  const hour = Number.isFinite(h) ? h : 9;
  const minute = Number.isFinite(m) ? m : 0;
  switch (d.repeat) {
    case "hourly":
      return presetToCron({ kind: "hourly", minute: d.minute });
    case "daily":
      return presetToCron({ kind: "daily", hour, minute });
    case "weekdays":
      return presetToCron({ kind: "weekdays", hour, minute });
    case "weekly":
      return presetToCron({ kind: "weekly", hour, minute, dayOfWeek: d.dayOfWeek });
    case "custom":
      return d.cron.trim();
  }
}

export function SchedulesSection({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const [data, setData] = useState<ScheduleListDto>({ schedules: [], runs: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
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
    setError(null);
    try {
      setData(await fn());
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const cron = draft ? draftCron(draft) : "";
  // 저장하기 전에 "그래서 언제 도나" 를 계산해 보여 준다. 식이 틀렸으면 여기서 바로 드러난다.
  const preview = useMemo(() => {
    if (!draft) return null;
    const c = parseCron(cron);
    if (!c) return null;
    return nextOccurrence(c, Date.now(), draft.timezone);
  }, [cron, draft?.timezone, draft]);

  const submit = async () => {
    if (!draft) return;
    setBusy(draft.id ?? "new");
    setError(null);
    try {
      setData(
        await window.workbench.schedules.save({
          ...(draft.id ? { id: draft.id } : {}),
          name: draft.name.trim(),
          cron,
          timezone: draft.timezone,
          prompt: draft.prompt.trim(),
          provider: draft.provider,
          policy: draft.policy,
          target: { kind: "fresh", workspaceId: draft.workspaceId, worktree: draft.worktree },
        }),
      );
      setDraft(null);
    } catch (e) {
      setError(humanError(e));
    } finally {
      setBusy(null);
    }
  };

  const set = (patch: Partial<Draft>) => {
    // 값을 고치는 순간 지난 오류는 치운다. 이미 채운 칸을 계속 지적하고 있으면 무엇이 문제인지 흐려진다.
    setError(null);
    setDraft((d) => (d ? { ...d, ...patch } : d));
  };

  return (
    <div data-schedules-section>
      <div className="mb-5 flex items-start justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold">예약</h1>
          <p className="mt-1 text-muted">정해진 시각에 프롬프트를 보냅니다. 회차마다 결과가 남습니다.</p>
        </div>
        {!draft && (
          <button
            onClick={() => {
              setError(null);
              setDraft(blankDraft(workspaces[0]?.id ?? ""));
            }}
            className="shrink-0 rounded-md border border-line px-2.5 py-1.5 text-[12.5px] hover:bg-panel-2"
            data-new-schedule
          >
            새 예약
          </button>
        )}
      </div>

      {error && (
        <div className="mb-3 rounded-md border border-err/40 bg-err/10 px-3 py-2 text-[12.5px] text-err" data-schedule-error>
          {error}
        </div>
      )}

      {draft && (
        <div className="mb-4 rounded-lg border border-line bg-panel px-4 py-3" data-schedule-form>
          <div className="flex flex-col gap-3 text-[12.5px]">
            <label className="flex flex-col gap-1">
              <span className="text-muted">이름</span>
              <input value={draft.name} onChange={(e) => set({ name: e.target.value })} placeholder="아침 점검" className={field} data-f-name />
            </label>

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex flex-col gap-1">
                <span className="text-muted">언제</span>
                <select value={draft.repeat} onChange={(e) => set({ repeat: e.target.value as Repeat })} className={field} data-f-repeat>
                  <option value="hourly">매시</option>
                  <option value="daily">매일</option>
                  <option value="weekdays">평일</option>
                  <option value="weekly">매주</option>
                  <option value="custom">직접 (cron)</option>
                </select>
              </label>
              {draft.repeat === "weekly" && (
                <label className="flex flex-col gap-1">
                  <span className="text-muted">요일</span>
                  <select value={draft.dayOfWeek} onChange={(e) => set({ dayOfWeek: Number(e.target.value) })} className={field}>
                    {WEEKDAYS.map((w, i) => (
                      <option key={w} value={i}>
                        {w}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              {draft.repeat === "hourly" ? (
                <label className="flex flex-col gap-1">
                  <span className="text-muted">분</span>
                  <input
                    type="number"
                    min={0}
                    max={59}
                    value={draft.minute}
                    onChange={(e) => set({ minute: Math.min(59, Math.max(0, Number(e.target.value) || 0)) })}
                    className={`${field} w-20`}
                  />
                </label>
              ) : draft.repeat === "custom" ? (
                <label className="flex min-w-[180px] flex-1 flex-col gap-1">
                  <span className="text-muted">cron (분 시 일 월 요일)</span>
                  <input value={draft.cron} onChange={(e) => set({ cron: e.target.value })} className={`${field} mono`} data-f-cron />
                </label>
              ) : (
                <label className="flex flex-col gap-1">
                  <span className="text-muted">시각</span>
                  <input type="time" value={draft.time} onChange={(e) => set({ time: e.target.value })} className={`${field} w-32`} data-f-time />
                </label>
              )}
            </div>

            <div className="mono text-[11px] text-muted-2" data-f-preview>
              {parseCron(cron) ? `${cron} · ${draft.timezone} · 다음 ${when(preview)}` : "cron 형식이 아닙니다 (분 시 일 월 요일)"}
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <label className="flex min-w-[160px] flex-1 flex-col gap-1">
                <span className="text-muted">어디서</span>
                <select value={draft.workspaceId} onChange={(e) => set({ workspaceId: e.target.value })} className={field} data-f-ws>
                  <option value="">워크스페이스를 고르세요</option>
                  {workspaces.map((w) => (
                    <option key={w.id} value={w.id}>
                      {w.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted">도구</span>
                <select value={draft.provider} onChange={(e) => set({ provider: e.target.value as ProviderId })} className={field}>
                  <option value="claude">Claude Code</option>
                  <option value="codex">Codex</option>
                </select>
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-muted">권한</span>
                <select value={draft.policy} onChange={(e) => set({ policy: e.target.value as PermissionPolicy })} className={field} data-f-policy>
                  {(Object.keys(POLICY_LABEL) as PermissionPolicy[]).map((p) => (
                    <option key={p} value={p}>
                      {POLICY_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
            </div>

            <label className="flex cursor-pointer items-start gap-2">
              <input type="checkbox" checked={draft.worktree} onChange={(e) => set({ worktree: e.target.checked })} className="mt-0.5" data-f-worktree />
              <span>
                <span className="block">격리 세션에서 돌린다</span>
                <span className="block text-[11.5px] text-muted">작업 폴더를 따로 만들어 그 안에서 돕니다. 원본은 그대로 둡니다.</span>
              </span>
            </label>

            {draft.policy === "full" && (
              <p className="text-[11.5px] text-warn">사람이 안 보는 사이에 승인 없이 돕니다. 격리 세션과 함께 쓰는 편이 안전합니다.</p>
            )}

            <label className="flex flex-col gap-1">
              <span className="text-muted">보낼 말</span>
              <textarea
                value={draft.prompt}
                onChange={(e) => set({ prompt: e.target.value })}
                rows={4}
                placeholder="어제 커밋을 훑고 빠진 테스트가 있으면 알려 줘."
                className={`${field} resize-y`}
                data-f-prompt
              />
            </label>

            <div className="flex items-center gap-2">
              <button
                onClick={() => void submit()}
                disabled={busy !== null}
                className="rounded-md bg-accent px-3 py-1.5 text-[12.5px] text-on-accent disabled:opacity-50"
                data-f-save
              >
                {draft.id ? "저장" : "만들기"}
              </button>
              <button onClick={() => setDraft(null)} className="rounded-md border border-line px-3 py-1.5 text-[12.5px] hover:bg-panel-2">
                취소
              </button>
            </div>
          </div>
        </div>
      )}

      {data.schedules.length === 0 ? (
        !draft && (
          <div className="rounded-lg border border-line bg-panel px-4 py-6 text-muted">
            <p>아직 예약이 없습니다.</p>
            <p className="mt-2 text-[12px] text-muted-2">
              오른쪽 위 “새 예약” 으로 만듭니다. 터미널에서도 됩니다:
              <code className="mono ml-1">atelier schedule add --name 아침점검 --cron "30 9 * * *" --prompt "…" --ws repo</code>
            </p>
          </div>
        )
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
                      onClick={() => {
                        setError(null);
                        setDraft(toDraft(s));
                      }}
                      title="고치기"
                      className="rounded-md px-2 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
                      data-edit-schedule
                    >
                      고치기
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
