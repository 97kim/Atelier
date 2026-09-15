// "사용자 응답이 필요한 세션" 추적. 사이드바·탭바의 점과 Dock 배지 숫자의 근거가 된다.
//   permission: 권한 다이얼로그가 떠 있다 (앱 모드의 waiting_permission, 터미널 모드의 훅 감지 모두)
//   done/error: 사용자가 보고 있지 않을 때 턴이 끝났다 — 탭을 보면(활성 + 창 포커스) 지운다
// 순수 상태 머신이라 Electron 없이 테스트한다 (attention.test.ts).

import type { ChatEvent, SessionStatus } from "@shared/chat-events";

export type AttentionKind = "permission" | "done" | "error";

export interface AttentionDeps {
  /** 이 탭이 지금 화면에 보이는가 (활성 탭이고 창에 포커스가 있다). */
  isViewing(tabId: string): boolean;
  onChange(map: Record<string, AttentionKind>): void;
}

export class AttentionTracker {
  private readonly map = new Map<string, AttentionKind>();

  constructor(private readonly deps: AttentionDeps) {}

  snapshot(): Record<string, AttentionKind> {
    return Object.fromEntries(this.map);
  }

  /** 응답이 필요한 세션 수 — Dock 배지. */
  count(): number {
    return this.map.size;
  }

  status(tabId: string, status: SessionStatus): void {
    if (status === "waiting_permission") this.set(tabId, "permission");
    else if (status === "running" || status === "queued") this.set(tabId, null);
    else if (this.map.get(tabId) === "permission") this.set(tabId, null);
  }

  /**
   * 세션 이벤트. status 이벤트는 어댑터가 setStatus 를 거치지 않고 직접 흘리기도 해서(waiting_permission)
   * 여기서도 받는다. 턴 결과는 보고 있지 않으면 완료/오류 표시를 남긴다.
   */
  event(tabId: string, event: ChatEvent): void {
    if (event.type === "status") {
      this.status(tabId, event.status);
    } else if (event.type === "turn_result") {
      if (this.deps.isViewing(tabId)) this.set(tabId, null);
      else this.set(tabId, event.isError ? "error" : "done");
    } else if (event.type === "error" && event.fatal !== false) {
      if (!this.deps.isViewing(tabId)) this.set(tabId, "error");
    }
  }

  /**
   * 턴 밖에서 도는 백그라운드 작업이 끝났다. 턴 결과와 같은 취급 —
   * 알림 배너는 잠깐 떴다 사라지므로, 보고 있지 않았다면 탭에 표시를 남겨야 나중에 알아본다.
   * 권한 대기 중이면 덮지 않는다(그쪽이 더 급하다).
   */
  backgroundJob(tabId: string, failed: boolean): void {
    if (this.deps.isViewing(tabId)) return;
    if (this.map.get(tabId) === "permission") return;
    this.set(tabId, failed ? "error" : "done");
  }

  /** 터미널 모드의 권한 대기(훅 감지)가 켜지거나 꺼졌다. */
  terminalPermission(tabId: string, waiting: boolean): void {
    if (waiting) this.set(tabId, "permission");
    else if (this.map.get(tabId) === "permission") this.set(tabId, null);
  }

  /** 탭을 보게 됐다(활성화 또는 창 포커스 복귀). 권한 대기는 답할 때까지 남긴다. */
  viewed(tabId: string): void {
    const cur = this.map.get(tabId);
    if (cur === "done" || cur === "error") this.set(tabId, null);
  }

  forget(tabId: string): void {
    this.set(tabId, null);
  }

  private set(tabId: string, kind: AttentionKind | null) {
    const cur = this.map.get(tabId) ?? null;
    if (cur === kind) return;
    if (kind) this.map.set(tabId, kind);
    else this.map.delete(tabId);
    this.deps.onChange(this.snapshot());
  }
}
