import i18next from "i18next";
import { useTranslation } from "react-i18next";
import type { SessionStatus } from "@shared/chat-events";
import type { SessionAttention } from "@shared/ipc";

// 라벨은 부를 때 번역한다(문구를 값으로 담아 두지 않는다). 밖에서는 문자열로 읽으므로 renderer 의 i18next 를 직접 쓴다.
export const statusLabel = (status: SessionStatus): string => i18next.t(`chat.status.${status}`);

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

export const attentionLabel = (kind: SessionAttention): string => i18next.t(`chat.attention.${kind}`);

/** 응답 필요 표시가 있으면 그것이 상태 점을 대신한다 (터미널 모드는 status 가 idle 이라 이 경로가 필요). */
export function effectiveLabel(
  status: SessionStatus,
  attention: SessionAttention | null | undefined,
): string {
  return attention ? attentionLabel(attention) : statusLabel(status);
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
  useTranslation(); // 언어를 바꾸면 title 이 따라오게 다시 그린다
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
