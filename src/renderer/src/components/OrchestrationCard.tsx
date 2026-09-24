// 코디네이터 탭에 남는 오케스트레이션 카드 — Run 의 Task 상태·워커 탭 링크·주의(질문/에스컬레이션/통지) 수. "패널" 로 인박스를 연다.
import type { OrchestrationBlock } from "@shared/session-state";
import { PROVIDER_NAME } from "@shared/fanout";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";

const TASK_LABEL: Record<string, [string, string]> = {
  pending: ["대기", "text-muted-2"],
  running: ["진행 중", "text-accent"],
  succeeded: ["성공", "text-ok"],
  failed: ["실패", "text-err"],
  abandoned: ["포기", "text-warn"],
};

const EXEC_LABEL: Record<string, string> = {
  running: "실행 중",
  queued: "대기열",
  waiting_permission: "권한 대기",
  waiting_reply: "답 기다림",
  limit_wait: "한도 대기",
  idle: "멈춤",
  error: "오류",
  unknown: "",
};

export function OrchestrationCard({ block, onOpen }: { block: OrchestrationBlock; onOpen: (runId: string) => void }) {
  const attention = block.questions + block.escalations;
  return (
    <div className="content-indent rounded-lg border border-line bg-panel" data-orch-card={block.id} data-orch-status={block.status}>
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-3 py-2">
        <Icon name="list" size={13} className="shrink-0 text-accent" />
        <span className="shrink-0 font-medium">오케스트레이션</span>
        <span className="min-w-0 truncate text-[11.5px] text-muted" title={block.objective}>
          {block.objective}
        </span>
        <span className="flex-1" />
        {block.questions > 0 && (
          <span className="label text-warn" data-orch-questions={block.questions}>
            질문 {block.questions}
          </span>
        )}
        {block.escalations > 0 && <span className="label text-err">에스컬레이션 {block.escalations}</span>}
        {block.gates > 0 && (
          <span className="label text-warn" data-orch-gates={block.gates}>
            게이트 {block.gates}개 대기
          </span>
        )}
        {block.status === "closed" && <span className="label text-muted-2">닫힘</span>}
        <button
          onClick={() => onOpen(block.id)}
          className={`rounded-md border px-2 py-0.5 text-[10.5px] ${attention > 0 ? "border-warn/40 bg-warn-bg text-warn hover:bg-warn/10" : "border-line text-muted hover:bg-panel-2 hover:text-fg"}`}
          title="Run 패널에서 Task와 워커, 인박스 보기"
          data-orch-open
        >
          자세히 보기
        </button>
      </div>
      <div>
        {block.tasks.length === 0 && <div className="px-3 py-2 text-[11.5px] text-muted">아직 Task가 없습니다.</div>}
        {block.tasks.map((t) => {
          const [label, tone] = TASK_LABEL[t.status] ?? [t.status, "text-muted"];
          return (
            <div key={t.id} className="flex items-start gap-2 border-t border-line px-3 py-1.5 first:border-t-0" data-orch-task={t.id} data-orch-task-status={t.status}>
              <span className="mono mt-0.5 w-4 shrink-0 text-[11px] text-muted">{t.seq}</span>
              {t.provider ? <ProviderLogo provider={t.provider} size={14} className="mt-0.5 shrink-0" /> : <span className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="min-w-0 truncate text-[12px]" title={t.spec}>
                    {t.spec}
                  </span>
                  <span className={`label shrink-0 ${tone}`}>{t.status === "pending" && t.blocked ? t.blocked : label}</span>
                  {t.status === "running" && t.execution && EXEC_LABEL[t.execution] && <span className="shrink-0 text-[10.5px] text-muted-2">{EXEC_LABEL[t.execution]}</span>}
                  <span className="flex-1" />
                  {t.tabId && (
                    <button onClick={() => void window.workbench.workspaces.activateTab(t.tabId!)} className="shrink-0 rounded-md border border-line px-2 py-0.5 text-[10.5px] text-muted hover:bg-panel-2 hover:text-fg" title={`워커의 작업 탭 열기 (${t.provider ? PROVIDER_NAME[t.provider] : ""})`} data-orch-task-tab>
                      탭
                    </button>
                  )}
                </div>
                {t.summary && <div className="mt-0.5 line-clamp-2 text-[11.5px] text-muted" style={{ userSelect: "text" }}>{t.summary}</div>}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
