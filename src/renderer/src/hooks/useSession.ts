import { useEffect, useReducer, useState } from "react";
import type { ChatEvent } from "@shared/chat-events";
import type { SessionSnapshotDto } from "@shared/ipc";
import {
  initialSessionState,
  reduceSession,
  replaySession,
  type SessionState,
} from "@shared/session-state";

type Action =
  | { kind: "event"; event: ChatEvent }
  | { kind: "replay"; events: ChatEvent[] };

function reducer(state: SessionState, action: Action): SessionState {
  if (action.kind === "replay") return replaySession(action.events);
  return reduceSession(state, action.event);
}

/**
 * 탭 하나의 이벤트 스트림을 구독해 순수 리듀서로 상태를 만든다.
 * 마운트 시 main 의 이벤트 로그를 재생해 (핫 리로드·대화 비우기 후에도) 화면과 main 을 맞춘다.
 */
export function useSession(tabId: string) {
  const [state, dispatch] = useReducer(reducer, undefined, initialSessionState);
  const [config, setConfig] = useState<SessionSnapshotDto | null>(null);

  useEffect(() => {
    let alive = true;
    const off = window.workbench.chat.onEvent(({ tabId: id, event }) => {
      if (id === tabId) dispatch({ kind: "event", event });
    });
    window.workbench.chat.events(tabId).then((events) => {
      if (alive) dispatch({ kind: "replay", events });
    });
    // 마운트 직후의 조회가 푸시보다 늦게 도착하면 더 새 값을 옛 값으로 덮게 된다 — 푸시가 먼저 왔으면 조회 결과는 버린다.
    let pushed = false;
    window.workbench.chat
      .snapshot(tabId)
      .then((s) => alive && !pushed && setConfig(s))
      .catch(console.error);
    // 컨트롤러 전환(터미널 ↔ 앱)·설정 변경처럼 main 이 먼저 바꾼 스냅샷을 받는다.
    const offSnap = window.workbench.chat.onSnapshotChanged((s) => {
      if (s.tabId === tabId) {
        pushed = true;
        setConfig(s);
      }
    });
    return () => {
      alive = false;
      off();
      offSnap();
    };
  }, [tabId]);

  // 대화 비우기 등 main 쪽 로그가 통째로 바뀌면 hash 변경으로 재생을 트리거한다.
  useEffect(() => {
    const onHash = () => {
      window.workbench.chat
        .events(tabId)
        .then((events) => dispatch({ kind: "replay", events }));
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, [tabId]);

  return { state, config, setConfig };
}
