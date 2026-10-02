// 팬아웃(지시 하나 → 격리 세션 N개)의 순수 부분 — 세션 이름·제목·요약·비교용 파일 합집합. 실행은 main/index.ts startFanout.
import type { FanoutVariant } from "./chat-events";
import type { GitChangeDto } from "./ipc";
import { UNTITLED_TAB } from "./workspace-model";

export const FANOUT_MAX_VARIANTS = 4;
export const FANOUT_MIN_VARIANTS = 2;
/** 카드에 남기는 지시·답변 요약 길이. */
export const FANOUT_PROMPT_EXCERPT = 300;
export const FANOUT_SUMMARY_EXCERPT = 400;

export const PROVIDER_NAME: Record<"claude" | "codex", string> = { claude: "Claude Code", codex: "Codex" };

export function variantLabel(index: number): string {
  return String.fromCharCode(65 + index);
}

/** 세션 탭 제목: "팬아웃 A · Codex". 원래 탭 제목이 있으면 뒤에 붙인다. */
export function fanoutTabTitle(label: string, provider: "claude" | "codex", originTitle?: string | null): string {
  const base = `팬아웃 ${label} · ${PROVIDER_NAME[provider]}`;
  return originTitle && originTitle !== UNTITLED_TAB ? `${base} · ${originTitle.slice(0, 24)}` : base;
}

export function excerpt(text: string, max: number): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
}

/** 세션 진행 요약: "2/3 완료 · 1 응답 필요". */
export function fanoutSummary(variants: FanoutVariant[]): string {
  const done = variants.filter((v) => v.status === "done").length;
  const waiting = variants.filter((v) => v.status === "waiting").length;
  const failed = variants.filter((v) => v.status === "failed").length;
  const cleaned = variants.filter((v) => v.status === "cleaned").length;
  if (cleaned === variants.length) return "비교 종료";
  const parts = [`${done}/${variants.length} 완료`];
  if (waiting) parts.push(`${waiting} 응답 필요`);
  if (failed) parts.push(`${failed} 실패`);
  return parts.join(" · ");
}

export function changeStats(changes: GitChangeDto[]): { files: number; added: number; deleted: number } {
  return changes.reduce((n, c) => ({ files: n.files + 1, added: n.added + c.added, deleted: n.deleted + c.deleted }), { files: 0, added: 0, deleted: 0 });
}

/** 비교 화면의 파일 목록: 모든 세션의 변경 경로 합집합(정렬), 경로마다 어느 세션이 건드렸는지. */
export function unionPaths(variants: { label: string; changes: GitChangeDto[] }[]): { path: string; labels: string[] }[] {
  const map = new Map<string, string[]>();
  for (const v of variants) for (const c of v.changes) map.set(c.path, [...(map.get(c.path) ?? []), v.label]);
  return [...map.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([path, labels]) => ({ path, labels }));
}

/** 팬아웃 전체가 끝났는지(모든 세션이 running/waiting 을 벗어남). */
export function allSettled(variants: FanoutVariant[]): boolean {
  return variants.every((v) => v.status !== "running" && v.status !== "waiting");
}

/** 시작 요청 검증 — 렌더러·CLI 입력 공통. */
export function validateFanoutRequest(o: { prompt: unknown; variants: unknown; policy?: unknown }): { ok: true; prompt: string; variants: { provider: "claude" | "codex"; model?: string }[]; policy: "ask" | "auto_edit" | "full" } | { ok: false; error: string } {
  const prompt = typeof o.prompt === "string" ? o.prompt.trim() : "";
  if (!prompt) return { ok: false, error: "AI에 보낼 요청을 입력하세요." };
  if (!Array.isArray(o.variants)) return { ok: false, error: "세션 목록을 읽을 수 없습니다. 세션을 다시 선택해 주세요." };
  const variants: { provider: "claude" | "codex"; model?: string }[] = [];
  for (const v of o.variants) {
    const provider = typeof v === "string" ? v : v && typeof v === "object" ? (v as { provider?: unknown }).provider : undefined;
    if (provider !== "claude" && provider !== "codex") return { ok: false, error: `세션에 사용할 CLI는 Claude Code 또는 Codex를 선택하세요. 전달된 값: ${String(provider)}` };
    const model = v && typeof v === "object" && typeof (v as { model?: unknown }).model === "string" ? ((v as { model: string }).model.trim() || undefined) : undefined;
    variants.push(model ? { provider, model } : { provider });
  }
  if (variants.length < FANOUT_MIN_VARIANTS) return { ok: false, error: `세션을 ${FANOUT_MIN_VARIANTS}개 이상 추가하세요.` };
  if (variants.length > FANOUT_MAX_VARIANTS) return { ok: false, error: `세션은 최대 ${FANOUT_MAX_VARIANTS}개까지 추가할 수 있습니다.` };
  const policy = o.policy === undefined ? "auto_edit" : o.policy;
  if (policy !== "ask" && policy !== "auto_edit" && policy !== "full") return { ok: false, error: "작업 권한을 다시 선택해 주세요. 허용되는 값: ask · auto_edit · full" };
  return { ok: true, prompt, variants, policy };
}
