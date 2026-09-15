// 턴이 끝난 뒤에도 도는 일(백그라운드 명령·하위 에이전트)을 보여 주는 줄.
//
// 대화 맨 끝에 두었더니 위로 올려 읽는 동안 화면 밖으로 밀려 보이지 않았다.
// 무엇이 도는지는 대화의 어느 지점을 보고 있든 알아야 하므로, 입력창 바로 위에 붙박이로 둔다.
//
// 도는 동안만 있다가 끝나면 사라진다. 끝났다는 사실은 알림과 탭 표시(attention)가 맡는다.

import { useEffect, useState } from "react";
import { jobRunningLabel, type BackgroundJobDto } from "@shared/background-jobs";

/** 한 번에 보여 줄 줄 수. 그 위로는 "외 n개" 로 접는다 — 붙박이라 화면을 많이 차지하면 안 된다. */
const VISIBLE_MAX = 2;

export function BackgroundJobsBar({ sessionId }: { sessionId: string | null }) {
  const [jobs, setJobs] = useState<BackgroundJobDto[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    let alive = true;
    void window.workbench.jobs.list().then((j) => alive && setJobs(j));
    const off = window.workbench.jobs.onChanged((j) => setJobs(j));
    return () => {
      alive = false;
      off();
    };
  }, []);
  const mine = sessionId ? jobs.filter((j) => j.sessionId === sessionId) : [];
  useEffect(() => {
    if (mine.length === 0) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [mine.length]);
  if (mine.length === 0) return null;
  const shown = mine.slice(0, VISIBLE_MAX);
  const hidden = mine.length - shown.length;
  return (
    <div className="flex flex-col items-center gap-1 border-t border-line px-4 pb-1.5 pt-2" data-background-jobs={mine.length}>
      {shown.map((j) => (
        <div key={j.id} className="flex max-w-full items-center gap-2 text-[11px] text-muted-2" data-background-job={j.id}>
          <span className="spin inline-block h-2.5 w-2.5 shrink-0 rounded-full border-[1.5px] border-warn border-t-transparent" />
          <span
            className="shrink-0 shimmer"
            style={{ "--shimmer-base": "var(--color-muted)", "--shimmer-hi": "var(--color-fg)" } as React.CSSProperties}
          >
            백그라운드
          </span>
          <span className="mono shrink-0">{jobRunningLabel(j, now)}</span>
          {j.summary && <span className="min-w-0 truncate opacity-70">{j.summary}</span>}
        </div>
      ))}
      {hidden > 0 && <div className="text-[11px] text-muted-2">외 {hidden}개</div>}
    </div>
  );
}
