import type { SessionStatus } from "@shared/chat-events";
import type { SessionAttention } from "@shared/ipc";

export const STATUS_LABEL: Record<SessionStatus, string> = {
  idle: "대기",
  queued: "대기열",
  running: "실행 중",
  waiting_permission: "권한 대기",
  error: "오류",
};

export function statusColor(status: SessionStatus): string {
  switch (status) {
    case "running":
      return "bg-accent animate-pulse";
    case "queued":
      return "bg-accent-2";
    case "waiting_permission":
      return "bg-warn";
    case "error":
      return "bg-err";
    default:
      return "bg-ok";
  }
}

export const ATTENTION_LABEL: Record<SessionAttention, string> = {
  permission: "권한 대기",
  done: "응답 도착",
  error: "오류 — 확인 필요",
};

/** 응답 필요 표시가 있으면 그것이 상태 점을 대신한다 (터미널 모드는 status 가 idle 이라 이 경로가 필요). */
export function effectiveLabel(
  status: SessionStatus,
  attention: SessionAttention | null | undefined,
): string {
  return attention ? ATTENTION_LABEL[attention] : STATUS_LABEL[status];
}

function attentionColor(kind: SessionAttention): string {
  switch (kind) {
    case "permission":
      return "bg-warn";
    case "error":
      return "bg-err";
    default:
      // 안 보는 사이 끝난 턴: 점을 키우고 링을 둘러 눈에 띄게
      return "bg-accent ring-2 ring-accent/30";
  }
}

export function StatusDot({
  status,
  attention = null,
  dim = false,
  className = "",
}: {
  status: SessionStatus;
  attention?: SessionAttention | null;
  dim?: boolean;
  className?: string;
}) {
  const color = dim
    ? "bg-muted-2"
    : attention
      ? attentionColor(attention)
      : statusColor(status);
  return (
    <span
      className={`inline-block h-1.5 w-1.5 shrink-0 rounded-full ${color} ${className}`}
      title={effectiveLabel(status, dim ? null : attention)}
      data-attention={attention ?? undefined}
    />
  );
}
