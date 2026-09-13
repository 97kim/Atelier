import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  CONTEXT_WARN_PCT,
  contextUsage,
  contextWarnLevel,
} from "@shared/session-state";
import type { PermissionAnswer, PermissionPolicy } from "@shared/chat-events";
import type {
  ChatImageDto,
  LimitWaitDto,
  PendingPromptDto,
  Provider,
  SessionSnapshotDto,
  WorkspaceStateDto,
  WorktreeStatusDto,
  FanoutStartDto,
} from "@shared/ipc";
import type { SlashCommandDto } from "@shared/slash-commands";
import { type WorktreeMeta,
  tabCwd,
  tabTitle,
  type TabMeta,
  type Workspace,
} from "@shared/workspace-model";
import { Composer } from "../components/Composer";
import { ContextPanel, shorten } from "../components/ContextPanel";
import { LocateFileContext, OpenFileContext, type LocateFile, type OpenFile } from "../components/FileViewer";
import { EditorPane } from "../components/EditorPane";
import { isBrowserTab, openBrowserTab, openEditorFile, setEditorPaneVisible, setLastPane, useEditorTabs } from "../editor-tabs";
import { appendComposerDraft, loadComposerDraft } from "../composer-draft";
import { Icon } from "../components/Icon";
import { ProviderLogo } from "../components/ProviderLogo";
import { MessageList } from "../components/MessageList";
import { PermissionPrompt } from "../components/PermissionPrompt";
import { HeaderMenu } from "../components/HeaderMenu";
import { ProviderSwitchModal } from "../components/ProviderSwitchModal";
import { ModelPickerModal } from "../components/ModelPickerModal";
import { VerifyPopover } from "../components/VerifyPopover";
import { FanoutModal } from "../components/FanoutModal";
import { FanoutCompare } from "../components/FanoutCompare";
import { OrchestrationPanel } from "../components/OrchestrationPanel";
import { modelFromArg, parseAppCommand } from "@shared/app-commands";
import { RightPanel } from "../components/RightPanel";
import { TabBar } from "../components/TabBar";
import { TerminalPanel } from "../components/TerminalPanel";
import { useSnippets } from "../hooks/useSnippets";
import { useSession } from "../hooks/useSession";
import {
  getCtxDismissed,
  setCtxDismissed,
  shouldShowCtxBanner,
} from "../ctx-dismiss";

const PROVIDER_LABEL: Record<Provider, string> = {
  claude: "Claude Code",
  codex: "Codex",
};

const EDITOR_W_KEY = "workbench.editorPane.width";
/** "작업 중" 으로 보는 세션 상태 — 같은 디렉토리 충돌 알림용. */
const BUSY_STATUS = new Set(["running", "waiting_permission", "queued"]);
const shortTitle = (t: string) => (t.length > 28 ? `${t.slice(0, 28)}…` : t);
/** 탭별로 닫아 둔 충돌 배너의 세션 조합 — ChatView 는 탭을 오갈 때마다 다시 마운트되므로 컴포넌트 밖에 둔다. */
const dismissedConcurrent = new Map<string, string>();

export function ChatView({
  tab,
  workspace,
  ws,
  onActivateTab,
  onCloseTab,
  onNewTab,
  onOpenMcp,
  onOpenSettings,
  onIsolate,
}: {
  tab: TabMeta;
  workspace: Workspace;
  /** 같은 디렉토리에서 다른 세션이 작업 중일 때 "격리 세션으로": 워크스페이스 저장소에 worktree 를 만들어 새 세션을 연다. */
  onIsolate: () => void;
  /** 탭 스트립은 헤더(타이틀바 줄) 아래에 붙으므로 여기서 그린다. */
  ws: WorkspaceStateDto;
  onActivateTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  /** "/mcp" 는 CLI 로 보내지 않고 설정의 MCP 서버 화면을 연다 (SDK 모드의 /mcp 는 요약 한 줄만 준다). */
  onOpenMcp: () => void;
  /** "/config" 는 CLI 로 보내지 않고 설정 화면을 연다. */
  /** 설정 화면으로. 섹션을 주지 않으면 CLI 탐지(/config). */
  onOpenSettings: (section?: "general" | "cli") => void;
}) {
  const tabId = tab.id;
  const { state, config, setConfig } = useSession(tabId);
  const [switching, setSwitching] = useState(false);
  // 에디터 패널(채팅 옆 분할). 변경 파일 목록·파일 트리·툴카드 경로 클릭으로 파일을 연다. 열린 파일은 탭마다 기억.
  const editorTabs = useEditorTabs(tabId);
  const openFile = useCallback<OpenFile>((path, at) => openEditorFile(tabId, path, at), [tabId]);
  // 에디터 선택·터미널 출력 → 입력창(마운트돼 있으면 바로 잇고 포커스, 아니면 초안에)
  const attachToChat = useCallback((block: string, images?: ChatImageDto[]) => appendComposerDraft(tabId, block, images), [tabId]);
  const [editorWidth, setEditorWidth] = useState(() => {
    try {
      return Math.min(1200, Math.max(360, Number(localStorage.getItem(EDITOR_W_KEY)) || 620));
    } catch {
      return 620;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(EDITOR_W_KEY, String(editorWidth));
    } catch {
      /* 무시 */
    }
  }, [editorWidth]);
  // 왼쪽 가장자리를 끌어 에디터 폭 조절 (왼쪽으로 끌면 넓어진다)
  const onEditorDragStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startW = editorWidth;
      const move = (ev: MouseEvent) =>
        setEditorWidth(Math.min(1200, Math.max(360, startW + (startX - ev.clientX))));
      const up = () => {
        window.removeEventListener("mousemove", move);
        window.removeEventListener("mouseup", up);
        document.body.style.cursor = "";
      };
      document.body.style.cursor = "col-resize";
      window.addEventListener("mousemove", move);
      window.addEventListener("mouseup", up);
    },
    [editorWidth],
  );

  // 통합 터미널 패널. 한 번 열리면 닫아도 마운트를 유지해 스크롤백을 보존한다.
  const [terminalOpen, setTerminalOpen] = useState(false);
  const [terminalMounted, setTerminalMounted] = useState(false);
  const toggleTerminal = useCallback(() => {
    setTerminalMounted(true);
    setTerminalOpen((o) => !o);
  }, []);
  useEffect(
    () =>
      window.workbench.app.onShortcut((name) => {
        if (name === "toggle-terminal") toggleTerminal();
      }),
    [toggleTerminal],
  );
  const attachTerminal = async () => {
    setAttachError(null);
    setTerminalMounted(true);
    setTerminalOpen(true);
    const r = await window.workbench.chat.attachTerminal(tabId);
    if (r.ok) setConfig(r.snapshot);
    else setAttachError(r.error);
  };
  const detachTerminal = () => void window.workbench.chat.detachTerminal(tabId);
  // 교차 리뷰: main 이 diff 를 모아 다른 provider 탭에 보내고 결과 카드를 이 탭에 남긴다
  const [reviewBusy, setReviewBusy] = useState(false);
  const requestCrossReview = async () => {
    setReviewBusy(true);
    setAttachError(null);
    try {
      const r = await window.workbench.chat.crossReview(tabId);
      if (!r.ok) setAttachError(r.error);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setReviewBusy(false);
    }
  };
  // 검증: 워크스페이스에 저장한 명령을 이 탭의 cwd 에서 돌리고 결과 카드를 이 탭에 남긴다(main 의 VerifyRunner)
  const [verifyOpen, setVerifyOpen] = useState(false);
  const verifyRunning = state.blocks.some((b) => b.kind === "verify" && b.status === "running");
  const savedVerify = workspace.verifyCommands ?? [];
  const runVerify = async (commands?: string[]) => {
    setAttachError(null);
    try {
      const r = await window.workbench.chat.verify(tabId, commands ? { commands } : undefined);
      if (!r.ok) setAttachError(r.error);
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    }
  };
  const saveVerify = (commands: string[]) => void window.workbench.workspaces.update(workspace.id, { verifyCommands: commands });
  const onVerifyClick = () => {
    if (verifyRunning) return;
    if (savedVerify.length > 0) void runVerify();
    else setVerifyOpen(true);
  };
  const closeVerify = useCallback(() => setVerifyOpen(false), []);
  const verifyAnchor = useRef<HTMLDivElement>(null);
  const moreAnchor = useRef<HTMLDivElement>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  // 팬아웃: 지시 하나를 격리 세션 N개에 — 시작 창과 비교 오버레이
  const [fanoutOpen, setFanoutOpen] = useState(false);
  const [compareFanoutId, setCompareFanoutId] = useState<string | null>(null);
  const closeFanout = useCallback(() => setFanoutOpen(false), []);
  const closeCompare = useCallback(() => setCompareFanoutId(null), []);
  // 오케스트레이션 패널(Run 인박스·워커). 헤더 버튼 또는 카드에서 연다
  const [orchPanel, setOrchPanel] = useState<{ runId: string | null } | null>(null);
  const closeOrch = useCallback(() => setOrchPanel(null), []);
  const startFanout = useCallback(
    async (req: FanoutStartDto): Promise<string | null> => {
      try {
        const r = await window.workbench.chat.fanout(tabId, req);
        return r.ok ? null : r.error;
      } catch (e) {
        return e instanceof Error ? e.message : String(e);
      }
    },
    [tabId],
  );
  const running = state.status !== "idle" && state.status !== "error";
  // Skill·Agent 카드가 결과 없이 열려 있으면 하위 에이전트(예: codex:rescue → Codex)가 턴을 잡고 있는 것
  const agentBlock = running ? state.blocks.find((b) => b.kind === "tool" && !b.result && ["Skill", "Agent", "Task"].includes(b.name)) : undefined;
  const agentBusy = agentBlock && agentBlock.kind === "tool" ? agentBlock.name : null;
  // companion 이 띄운 Codex 가 일하는 중이면 힌트에 그렇게 적는다(카드의 Codex 배지와 같은 근거)
  const agentViaCodex = agentBlock && agentBlock.kind === "tool" && agentBlock.subagent?.via === "codex";
  // 하이브리드: 터미널(CLI TUI)이 세션을 제어 중이면 채팅은 미러만 하고 입력은 잠근다.
  const terminalControlled = config?.controller === "terminal";
  // 터미널 모드에서 CLI 가 권한 승인을 기다리는 중 (Claude 훅으로 감지). 배너를 경고색으로 바꾼다.
  const attention = terminalControlled
    ? (config?.terminalAttention ?? null)
    : null;
  const [attachError, setAttachError] = useState<string | null>(null);
  // 컨텍스트 창 경고: 80% 부터. 닫음 상태는 탭 id 로 컴포넌트 밖에 기억한다(탭을 오가도 유지).
  // 경고 구간 아래로 내려오면(새 세션의 첫 턴 등) 닫음이 풀린다.
  const ctx = contextUsage(state);
  const ctxPct = ctx?.pct ?? null;
  const ctxLevel = contextWarnLevel(ctxPct);
  const [ctxDismissTick, setCtxDismissTick] = useState(0);
  const ctxDismissed = getCtxDismissed(tabId);
  useEffect(() => {
    // pct 가 null 인 순간(마운트 직후 재생 전)은 판단 보류 — 그때 풀면 탭을 오갈 때마다 닫음이 사라진다.
    if (ctxDismissed && ctxPct !== null && ctxPct < CONTEXT_WARN_PCT) {
      setCtxDismissed(tabId, null);
      setCtxDismissTick((n) => n + 1);
    }
  }, [tabId, ctxPct, ctxDismissed]);
  const dismissCtx = () => {
    if (ctxPct !== null && ctxLevel) setCtxDismissed(tabId, { pct: ctxPct, level: ctxLevel });
    setCtxDismissTick((n) => n + 1);
  };
  void ctxDismissTick;
  const ctxBanner =
    ctxLevel !== null &&
    ctxPct !== null &&
    !terminalControlled &&
    shouldShowCtxBanner(ctxPct, ctxLevel, ctxDismissed);
  const [ctxBusy, setCtxBusy] = useState(false);
  // 같은 provider 로 "요약 + 새 세션": 기존 handoff 경로를 그대로 쓴다 (다음 메시지 앞에 요약이 붙는다).
  const compactToNewSession = async () => {
    if (!config) return;
    setCtxBusy(true);
    try {
      setConfig(
        await window.workbench.chat.switchProvider(tabId, {
          provider: config.provider,
          model: config.model,
          preserveContext: true,
        }),
      );
      // session_reset 이벤트가 lastTurn 을 비워 배너·게이지가 함께 내려간다.
    } catch (e) {
      setAttachError(e instanceof Error ? e.message : String(e));
    } finally {
      setCtxBusy(false);
    }
  };

  // "/model" 피커. "/model opus" 처럼 인자가 있으면 피커 없이 바로 바꾼다.
  const [modelPicker, setModelPicker] = useState(false);
  const setModel = useCallback(
    async (model: string) => {
      setConfig(await window.workbench.chat.configure(tabId, { model }));
    },
    [tabId, setConfig],
  );

  const onSend = useCallback(
    async (text: string, images: ChatImageDto[]) => {
      const cmd = images.length === 0 ? parseAppCommand(text) : null;
      if (cmd?.name === "mcp") return onOpenMcp();
      if (cmd?.name === "config") return onOpenSettings();
      if (cmd?.name === "model") {
        if (cmd.arg) await setModel(modelFromArg(cmd.arg));
        else setModelPicker(true);
        return;
      }
      const r = await window.workbench.chat.send(tabId, { text, images });
      if (!r.ok) throw new Error(r.error);
      setConfig(await window.workbench.chat.snapshot(tabId));
    },
    [tabId, setConfig, onOpenMcp, onOpenSettings, setModel],
  );

  const onAnswer = useCallback(
    (answer: PermissionAnswer) => {
      const req = state.pendingPermission;
      if (req)
        void window.workbench.chat.answerPermission(
          tabId,
          req.requestId,
          answer,
        );
    },
    [tabId, state.pendingPermission],
  );

  // 세션 작업 경로: 디렉토리 선택 → configure(cwd). 바뀌면 provider 세션은 새로 시작한다.
  const pickCwd = async () => {
    const dir = await window.workbench.dialog.pickDirectory();
    if (dir)
      setConfig(await window.workbench.chat.configure(tabId, { cwd: dir }));
  };

  const onPolicy = (policy: PermissionPolicy) =>
    void window.workbench.chat.configure(tabId, { policy }).then(setConfig);

  const onClear = async () => {
    setConfig(await window.workbench.chat.clear(tabId));
    // 리듀서 상태는 main 의 이벤트 로그 재생으로 맞춘다.
    window.location.hash = `#cleared-${Date.now()}`;
  };

  const loadHandoff = useCallback(
    () => window.workbench.chat.handoffPreview(tabId),
    [tabId],
  );

  const title = tabTitle(tab);
  // 세션 이름 인라인 편집: 제목 클릭 또는 탭 더블클릭. Enter 저장, esc 취소, 빈 값이면 자동 제목으로.
  const [editingTitle, setEditingTitle] = useState(false);
  const [draftTitle, setDraftTitle] = useState("");
  const titleInputRef = useRef<HTMLInputElement | null>(null);
  const startRename = useCallback(() => {
    setDraftTitle(tab.title ?? "");
    setEditingTitle(true);
  }, [tab.title]);
  useEffect(() => {
    if (editingTitle) titleInputRef.current?.select();
  }, [editingTitle]);
  const commitRename = useCallback(async () => {
    setEditingTitle(false);
    if (draftTitle.trim() === (tab.title ?? "").trim()) return;
    await window.workbench.workspaces.renameTab(tabId, draftTitle);
  }, [draftTitle, tab.title, tabId]);
  const cwd = config?.cwd ?? workspace.path;
  // 답변 속 파일 참조 → 실제 경로. Markdown 의 FileRef 가 부른다(결과 캐시는 FileRef 쪽).
  const locateFile = useMemo<LocateFile>(
    () => ({ cwd: cwd || null, locate: (ref) => (cwd ? window.workbench.files.locate(cwd, ref) : Promise.resolve([])) }),
    [cwd],
  );
  // 같은 디렉토리에서 작업 중인 다른 세션 — 같은 파일을 고치면 서로 덮어쓸 수 있어 알린다. 닫으면 그 조합이 바뀔 때까지 다시 안 띄운다
  // (닫은 조합은 모듈에 기억해 탭을 오가며 다시 마운트돼도 유지). 세션 스냅샷이 오기 전엔 cwd 를 모르므로 계산하지 않는다(격리 탭 오탐 방지).
  const concurrent =
    cwd && config
      ? ws.model.tabs.filter((t) => t.id !== tabId && t.open && tabCwd(ws.model, t) === cwd && BUSY_STATUS.has(ws.statuses[t.id] ?? ""))
      : [];
  const concurrentKey = concurrent.map((t) => t.id).sort().join(",");
  const [concurrentDismissed, setConcurrentDismissedState] = useState(() => dismissedConcurrent.get(tabId) ?? "");
  const setConcurrentDismissed = (key: string) => {
    dismissedConcurrent.set(tabId, key);
    setConcurrentDismissedState(key);
  };
  const editorShown = editorTabs.visible && editorTabs.files.length > 0 && !!cwd;
  // 최대화: 채팅·오른쪽 패널을 잠시 숨기고 에디터/브라우저가 창 전체를 쓴다. 상태는 그대로 살아 있다(언마운트하지 않는다).
  const editorMaximized = editorShown && editorTabs.maximized;
  // 패널 토글 라벨: 파일 탭과 브라우저 탭을 따로 센다(브라우저만 열려 있는데 "코드 1" 로 보이지 않게).
  const fileTabCount = editorTabs.files.filter((f) => !isBrowserTab(f)).length;
  const browserTabCount = editorTabs.files.length - fileTabCount;
  const paneLabel = [fileTabCount > 0 ? `코드 ${fileTabCount}` : null, browserTabCount > 0 ? `브라우저 ${browserTabCount}` : null].filter(Boolean).join(" · ");
  const provider = config?.provider ?? tab.provider;

  const snippets = useSnippets();
  // "/" 자동완성용 슬래시 커맨드 목록. null = 해당 없음(Codex), [] = 아직 로딩 중.
  const [commands, setCommands] = useState<SlashCommandDto[] | null>(null);
  useEffect(() => {
    if (provider !== "claude" || !config) {
      setCommands(null);
      return;
    }
    let alive = true;
    setCommands([]);
    const load = () =>
      window.workbench.chat
        .commands(tabId)
        .then((c) => alive && setCommands(c))
        .catch(console.error);
    load();
    const off = window.workbench.chat.onCommandsChanged((changed) => {
      if (changed === cwd) load();
    });
    return () => {
      alive = false;
      off();
    };
  }, [tabId, provider, cwd, config !== null]);

  return (
    <OpenFileContext.Provider value={openFile}>
    <LocateFileContext.Provider value={locateFile}>
      <div className="relative flex h-full flex-col">
        {/* 타이틀바 줄: 세션 제목·경로·모델과 버튼. 제목 중심 56px = 사이드바 로고 줄. 탭 스트립은 이 아래. */}
        <header className="drag flex h-[68px] shrink-0 items-center gap-3 overflow-hidden px-6 pt-4">
          {/* 제목·경로는 버튼에 밀려 사라지면 안 된다 — 최소 폭을 확보한다(버튼은 shrink-0 이라 제목만 줄어든다) */}
          <div className="min-w-[220px] flex-1">
            {editingTitle ? (
              <input
                ref={titleInputRef}
                value={draftTitle}
                onChange={(e) => setDraftTitle(e.target.value)}
                onBlur={() => void commitRename()}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter") void commitRename();
                  else if (e.key === "Escape") setEditingTitle(false);
                }}
                placeholder="세션 이름"
                className="no-drag -mx-1.5 w-full max-w-[480px] rounded-md border border-accent/50 bg-panel px-1.5 text-[15px] font-semibold outline-none"
                style={{ userSelect: "text" }}
              />
            ) : (
              <button
                onClick={startRename}
                title="클릭해서 이름 변경"
                className="no-drag group -mx-1.5 flex max-w-full items-center gap-1.5 rounded-md px-1.5 text-left hover:bg-panel-2"
              >
                <span className="truncate text-[15px] font-semibold">
                  {title}
                </span>
                <Icon
                  name="edit"
                  size={11}
                  className="shrink-0 text-muted opacity-0 group-hover:opacity-100"
                />
              </button>
            )}
            <div className="mono mt-0.5 flex items-center gap-2 overflow-hidden whitespace-nowrap text-[10.5px] text-muted">
              <span
                className={`h-1.5 w-1.5 rounded-full ${statusDot(state.status)}`}
              />
              <span className="shrink-0">{workspace.name}</span>
              <span className="shrink-0">·</span>
              {cwd ? (
                <button
                  onClick={() => void pickCwd()}
                  disabled={running}
                  className="no-drag flex min-w-0 items-center gap-1 truncate rounded px-1 hover:bg-panel-2 hover:text-fg disabled:hover:bg-transparent"
                  title={
                    running
                      ? cwd
                      : `${cwd}\n작업 경로 변경 (provider 세션은 새로 시작)`
                  }
                  data-cwd
                >
                  <Icon name="folder" size={10} className="shrink-0" />
                  <span className="truncate">{shorten(cwd)}</span>
                </button>
              ) : (
                <button
                  onClick={() => void pickCwd()}
                  className="no-drag flex shrink-0 items-center gap-1 rounded bg-accent-tint px-1.5 py-0.5 text-accent hover:bg-accent/15"
                  title="이 세션이 작업할 디렉토리를 고릅니다"
                  data-cwd
                >
                  <Icon name="folder" size={10} />
                  작업 경로 선택…
                </button>
              )}
              {tab.worktree && (
                <WorktreeChip
                  tabId={tabId}
                  worktree={tab.worktree}
                  running={running}
                  onChanged={(snap) => snap && setConfig(snap)}
                />
              )}
              {(config?.model || state.model) && (
                <>
                  <span className="shrink-0">·</span>
                  <span
                    className="shrink-0"
                    title={config?.model ? "이 세션에 설정한 모델 (/model 로 변경)" : "마지막 턴이 쓴 모델 — 설정은 CLI 기본값 (/model 로 변경)"}
                    data-header-model
                  >
                    {config?.model || state.model}
                  </span>
                </>
              )}
              {state.status === "queued" && (
                <>
                  <span className="shrink-0">·</span>
                  <span
                    className="shrink-0 text-accent-2"
                    title="동시에 작업할 채팅 수를 넘겨 기다리는 중입니다. 자리가 나면 자동으로 시작합니다. 중단을 누르면 대기를 취소합니다."
                    data-queue-status
                  >
                    {config?.queueInfo
                      ? `실행 대기 ${config.queueInfo.position}번째 · 진행 중 ${config.queueInfo.running}/${config.queueInfo.max}${
                          config.queueInfo.waitingPermission > 0 ? ` (승인 대기 ${config.queueInfo.waitingPermission}개 포함)` : ""
                        }`
                      : "실행 대기"}
                  </span>
                  <button
                    onClick={() => onOpenSettings("general")}
                    className="no-drag shrink-0 text-muted underline-offset-2 hover:text-fg hover:underline"
                    title="설정 > 일반에서 동시에 작업할 채팅 수를 바꿉니다"
                  >
                    상한 설정
                  </button>
                </>
              )}
              {config?.handoffPending && (
                <>
                  <span>·</span>
                  <span className="text-accent">요약 전달 대기</span>
                </>
              )}
            </div>
          </div>
          {editorTabs.files.length > 0 && (
            <button
              onClick={() => setEditorPaneVisible(tabId, !editorTabs.visible)}
              className={`no-drag flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 ${
                editorShown
                  ? "border-accent/40 bg-accent-tint text-accent"
                  : "border-line bg-panel hover:bg-panel-2"
              }`}
              title={editorShown ? `에디터 패널 접기 (${paneLabel})` : `에디터 패널 펼치기 (${paneLabel})`}
              data-editor-toggle={editorShown ? "open" : "closed"}
            >
              {/* 옆의 "브라우저"(새 탭 열기) 버튼과 헷갈리지 않게 패널 아이콘 — 이 버튼은 패널을 접고 펴는 것 */}
              <Icon name="panelRight" size={11} />
              {paneLabel}
            </button>
          )}
          <button
            onClick={() => openBrowserTab(tabId)}
            className="no-drag flex shrink-0 items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 hover:bg-panel-2"
            title="인앱 브라우저 탭을 새로 엽니다 (개발 서버 미리보기·문서)"
            data-browser-open
          >
            <Icon name="globe" size={11} />
            {browserTabCount > 0 ? "새 브라우저" : "브라우저"}
          </button>
          <div className="relative flex shrink-0 items-stretch" ref={verifyAnchor}>
            <button
              onClick={onVerifyClick}
              disabled={!cwd || verifyRunning}
              className="no-drag flex items-center gap-2 rounded-l-md border border-line bg-panel px-3 py-1.5 hover:bg-panel-2 disabled:opacity-40"
              title={savedVerify.length > 0 ? `저장한 검증 명령 실행: ${savedVerify.join(" → ")}` : "검증 명령(테스트·빌드)을 정해 두고 한 번에 실행합니다"}
              data-verify={verifyRunning ? "running" : savedVerify.length > 0 ? "ready" : "empty"}
            >
              {verifyRunning ? <span className="spin inline-block h-3 w-3 rounded-full border-[1.5px] border-accent border-t-transparent" /> : <Icon name="check" size={11} />}
              {verifyRunning ? "검증 중" : "검증"}
            </button>
            <button
              onClick={() => setVerifyOpen((o) => !o)}
              disabled={!cwd}
              className={`no-drag flex items-center rounded-r-md border border-l-0 border-line px-1.5 py-1.5 hover:bg-panel-2 disabled:opacity-40 ${verifyOpen ? "bg-accent-tint text-accent" : "bg-panel text-muted"}`}
              title="검증 명령 편집"
              data-verify-edit
            >
              <Icon name="edit" size={10} />
            </button>
            {verifyOpen && <VerifyPopover tabId={tabId} anchor={verifyAnchor.current} saved={savedVerify} onSave={saveVerify} onRun={(cmds) => void runVerify(cmds)} onClose={closeVerify} />}
          </div>
          <button
            onClick={toggleTerminal}
            disabled={!cwd}
            className={`no-drag flex shrink-0 items-center gap-2 rounded-md border px-3 py-1.5 disabled:opacity-40 ${
              terminalOpen
                ? "border-accent/40 bg-accent-tint text-accent hover:bg-accent/15"
                : "border-line bg-panel hover:bg-panel-2"
            }`}
            title="터미널 패널 (⌘J)"
            data-terminal-toggle={terminalOpen ? "open" : "closed"}
          >
            <span
              className={`flex h-5 w-5 items-center justify-center rounded ${
                terminalOpen
                  ? "bg-accent text-on-accent"
                  : "bg-panel-2 text-muted"
              }`}
            >
              <Icon name="terminal" size={11} />
            </span>
            터미널
          </button>
          {terminalControlled && config?.terminalExternal ? (
            <span
              className="no-drag flex shrink-0 items-center gap-2 rounded-md border border-accent/40 bg-accent-tint px-3 py-1.5 text-accent"
              title="통합 터미널에서 직접 띄운 CLI 가 이 세션을 제어 중입니다. 그 CLI 를 종료(/exit)하면 채팅으로 돌아옵니다."
              data-external-terminal
            >
              <Icon name="terminal" size={12} />
              터미널의 CLI 에 연결됨
            </span>
          ) : terminalControlled ? (
            <button
              onClick={detachTerminal}
              className="no-drag flex shrink-0 items-center gap-2 rounded-md border border-accent/40 bg-accent-tint px-3 py-1.5 text-accent hover:bg-accent/15"
              title="터미널의 CLI 를 끊고 채팅으로 돌아옵니다"
              data-detach-terminal
            >
              <Icon name="chat" size={12} />
              채팅으로 돌아가기
            </button>
          ) : null}
          <div className="relative flex shrink-0" ref={moreAnchor}>
            <button
              onClick={() => setMoreOpen((o) => !o)}
              className={`no-drag flex items-center rounded-md border px-2 py-1.5 ${moreOpen ? "border-accent/40 bg-accent-tint text-accent" : "border-line bg-panel text-muted hover:bg-panel-2 hover:text-fg"}`}
              title="팬아웃·교차 리뷰·오케스트레이션·터미널로 이어가기"
              data-header-more={moreOpen ? "open" : "closed"}
            >
              <Icon name="more" size={13} />
            </button>
            {moreOpen && (
              <HeaderMenu
                anchor={moreAnchor.current}
                onClose={() => setMoreOpen(false)}
                items={[
                  {
                    key: "fanout",
                    label: "팬아웃",
                    icon: "sparkles",
                    hint: "같은 지시를 격리 세션 여러 개에 보내고 변경을 나란히 비교해 채택합니다",
                    disabled: !cwd || terminalControlled,
                    disabledReason: !cwd ? "작업 경로를 먼저 고르세요" : "터미널의 CLI 가 이 세션을 제어 중입니다",
                    onSelect: () => setFanoutOpen(true),
                  },
                  {
                    key: "cross-review",
                    label: "교차 리뷰",
                    icon: "switch",
                    hint: `작업 트리 변경을 ${provider === "claude" ? "Codex" : "Claude Code"} 새 탭에 보내 독립 리뷰를 받습니다`,
                    disabled: !cwd || terminalControlled || reviewBusy,
                    disabledReason: reviewBusy ? "리뷰가 이미 돌고 있습니다" : !cwd ? "작업 경로를 먼저 고르세요" : "터미널의 CLI 가 이 세션을 제어 중입니다",
                    onSelect: () => void requestCrossReview(),
                  },
                  {
                    key: "orchestration",
                    label: "오케스트레이션",
                    icon: "list",
                    hint: "Run 의 워커·질문·보고를 봅니다 (Run 은 atelier orch CLI 로 만듭니다)",
                    onSelect: () => setOrchPanel({ runId: null }),
                  },
                  {
                    key: "attach-terminal",
                    label: "터미널에서 이어가기",
                    icon: "play",
                    hint: "같은 세션을 터미널의 CLI 로 이어갑니다. 종료하면 채팅으로 돌아옵니다",
                    disabled: !cwd || running || terminalControlled,
                    disabledReason: terminalControlled ? "이미 터미널의 CLI 가 제어 중입니다" : running ? "턴이 끝난 뒤에 됩니다" : "작업 경로를 먼저 고르세요",
                    onSelect: () => void attachTerminal(),
                  },
                ]}
              />
            )}
          </div>
          <button
            onClick={() => setSwitching(true)}
            className="no-drag flex shrink-0 items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 hover:bg-panel-2"
          >
            <ProviderLogo provider={provider} size={20} />
            {PROVIDER_LABEL[provider]}
            <Icon name="chevronDown" size={12} className="text-muted" />
          </button>
        </header>

        <div className="flex min-h-0 flex-1">
          {/* 채팅 칼럼은 340px 아래로 눌리지 않는다 — 공간이 모자라면 에디터 패널이 먼저 줄어든다(아래 flex-basis/shrink).
              최대화 때는 숨기기만 한다 — 언마운트하면 스크롤 위치·입력 중이던 글이 날아간다. */}
          <div
            className={`flex min-w-[340px] flex-1 flex-col ${editorMaximized ? "hidden" : ""}`}
            onMouseDownCapture={() => setLastPane(tabId, "chat")}
            onFocusCapture={() => setLastPane(tabId, "chat")}
            data-chat-column
          >
            <TabBar
              ws={ws}
              onActivate={onActivateTab}
              onClose={onCloseTab}
              onNew={onNewTab}
              onRename={(id) =>
                id === tabId ? startRename() : onActivateTab(id)
              }
            />

            <div className="min-h-0 flex-1">
              <MessageList
                tabId={tabId}
                blocks={state.blocks}
                status={state.status}
                provider={provider}
                reasoning={state.reasoning}
                onRerunVerify={(cmds) => void runVerify(cmds)}
                onCompareFanout={setCompareFanoutId}
                onOpenOrchestration={(runId) => setOrchPanel({ runId })}
                turnStartedAt={config?.turnStartedAt ?? null}
                sessionId={config?.sessionId ?? null}
              />
            </div>

            {terminalMounted && cwd && (
              <TerminalPanel
                tabId={tabId}
                cwd={cwd}
                open={terminalOpen}
                onClose={() => setTerminalOpen(false)}
                onAttach={attachToChat}
              />
            )}

            {state.pendingPermission && (
              <PermissionPrompt
                // 앞 요청이 남긴 선택이 새 질문의 답으로 새지 않게 요청마다 새로 만든다
                key={state.pendingPermission.requestId}
                request={state.pendingPermission}
                onAnswer={onAnswer}
              />
            )}

            {config?.limitWait && (
              <LimitWaitBanner tabId={tabId} wait={config.limitWait} onChanged={setConfig} />
            )}

            {concurrent.length > 0 && concurrentDismissed !== concurrentKey && (
              <div className="mx-6 mb-2 flex items-center gap-2 rounded-lg border border-warn/40 bg-warn-bg px-3 py-2 text-[12px] text-warn" data-concurrent-banner>
                <Icon name="alert" size={13} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  같은 디렉토리에서 {concurrent.length}개 세션이 작업 중입니다: {concurrent.map((t) => shortTitle(tabTitle(t))).join(", ")}. 같은 파일을 고치면 서로 덮어쓸 수 있습니다.
                </span>
                <button onClick={() => onActivateTab(concurrent[0].id)} className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10" data-concurrent-view>
                  보기
                </button>
                <button onClick={onIsolate} className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10" title="워크스페이스 저장소에 git worktree 를 만들어 이 작업을 따로 진행합니다" data-concurrent-isolate>
                  격리 세션으로
                </button>
                <button onClick={() => setConcurrentDismissed(concurrentKey)} className="shrink-0 rounded p-0.5 hover:bg-warn/10" title="닫기" data-concurrent-dismiss>
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}

            {(config?.pendingPrompts.length ?? 0) > 0 && (
              <PendingQueue
                tabId={tabId}
                items={config!.pendingPrompts}
                idle={(config!.status === "idle" || config!.status === "error") && !config!.limitWait}
                onChanged={setConfig}
              />
            )}

            {ctxBanner && (
              <div
                className={`mx-6 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${
                  ctxLevel === "critical"
                    ? "border-err/40 bg-err-bg text-err"
                    : "border-warn/40 bg-warn-bg text-warn"
                }`}
                data-context-banner={ctxLevel}
              >
                <Icon name="alert" size={13} className="shrink-0" />
                <span className="min-w-0 flex-1">
                  컨텍스트 창을 {ctxPct}% 썼습니다
                  {ctx?.window
                    ? ` (${Math.round(Math.min(ctx.used, ctx.window) / 1000)}k / ${Math.round(ctx.window / 1000)}k)`
                    : ""}
                  .
                  {ctxLevel === "critical"
                    ? " 곧 자동 압축이 일어나거나 응답 품질이 떨어질 수 있습니다."
                    : " 대화를 요약해 새 세션으로 이어가면 비용과 지연이 줄어듭니다."}
                </span>
                <button
                  onClick={() => void compactToNewSession()}
                  disabled={ctxBusy || running || terminalControlled}
                  className={`shrink-0 rounded border px-2 py-0.5 disabled:opacity-40 ${
                    ctxLevel === "critical"
                      ? "border-err/40 hover:bg-err/10"
                      : "border-warn/40 hover:bg-warn/10"
                  }`}
                  title="지금까지의 대화를 요약해 다음 메시지에 붙이고, 컨텍스트가 빈 새 세션으로 이어갑니다"
                  data-context-compact
                >
                  {ctxBusy ? "정리 중…" : "요약해서 새 세션으로"}
                </button>
                <button
                  onClick={dismissCtx}
                  className="shrink-0 rounded p-0.5 hover:bg-fg/5"
                  data-context-dismiss
                  title="닫기 (5% 더 차거나 95% 를 넘으면 다시 알립니다)"
                >
                  <Icon name="x" size={12} />
                </button>
              </div>
            )}

            {(terminalControlled || attachError) && (
              <div
                className={`mx-6 mb-2 flex items-center gap-2 rounded-md border px-3 py-2 text-[12px] ${
                  attachError
                    ? "border-err/40 bg-err-bg text-err"
                    : attention
                      ? "border-warn/40 bg-warn-bg text-warn"
                      : "border-accent/30 bg-accent-tint text-accent"
                }`}
                data-terminal-banner
                data-terminal-attention={attention ? attention.kind : undefined}
              >
                <Icon
                  name={attachError || attention ? "alert" : "terminal"}
                  size={13}
                  className="shrink-0"
                />
                <span className="min-w-0 flex-1 truncate">
                  {attachError ??
                    (attention ? (
                      <>
                        터미널에서 권한 승인을 기다리고 있습니다:{" "}
                        <span className="font-medium">{attention.tool}</span>
                        {attention.summary && (
                          <code className="ml-1.5 rounded bg-fg/10 px-1 py-px font-mono text-[11px]">
                            {attention.summary}
                          </code>
                        )}
                      </>
                    ) : (
                      config?.terminalExternal
                        ? "통합 터미널에서 직접 띄운 CLI 에 연결됐습니다. 대화는 여기에도 따라 표시되고(첫 프롬프트부터), CLI 를 종료(/exit)하면 채팅으로 돌아옵니다."
                        : "터미널의 CLI 가 이 세션을 제어 중입니다. 대화는 여기에도 따라 표시되고, CLI 를 종료(/exit)하거나 위의 버튼을 누르면 채팅으로 돌아옵니다."
                    ))}
                </span>
                {attention && !terminalOpen && (
                  <button
                    onClick={toggleTerminal}
                    className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10"
                  >
                    터미널 보기
                  </button>
                )}
                {attachError && (
                  <button
                    onClick={() => setAttachError(null)}
                    className="rounded p-0.5 hover:bg-err/10"
                  >
                    <Icon name="x" size={12} />
                  </button>
                )}
              </div>
            )}

            <Composer
              disabled={!cwd || terminalControlled}
              disabledText={
                terminalControlled ? "터미널이 세션을 제어 중입니다" : undefined
              }
              running={running}
              runningHint={agentBusy ? `${agentViaCodex ? `${agentBusy} 이 맡긴 Codex 가 작업 중` : `${agentBusy} 가 하위 에이전트를 돌리는 중`} — 끝나면 답이 이어집니다. 다음 지시를 써 두면 그 뒤에 보냅니다…` : undefined}
              providerLabel={PROVIDER_LABEL[provider]}
              policy={config?.policy ?? "ask"}
              commands={commands}
              snippets={snippets}
              workspaceId={tab.workspaceId}
              draftKey={tabId}
              onSaveSnippet={(input) => window.workbench.snippets.save(input)}
              onSend={onSend}
              onAbort={() => void window.workbench.chat.abort(tabId)}
            />
          </div>

          {editorShown && (
            <>
              {/* 최대화면 경계선을 숨긴다 — 끌 것이 없다 */}
              {!editorMaximized && (
                <div
                  onMouseDown={onEditorDragStart}
                  className="w-1 shrink-0 cursor-col-resize hover:bg-accent/30"
                  data-editor-resizer
                />
              )}
              <div
                className={`mb-3 flex flex-col overflow-hidden rounded-xl bg-panel ${editorMaximized ? "ml-3 flex-1" : ""}`}
                style={editorMaximized ? undefined : { flex: `0 1 ${editorWidth}px`, minWidth: 360 }}
                onMouseDownCapture={() => setLastPane(tabId, "editor")}
                onFocusCapture={() => setLastPane(tabId, "editor")}
                data-editor-pane-shell
                data-editor-maximized={editorMaximized ? "true" : "false"}
              >
                <EditorPane tabId={tabId} cwd={cwd} tabs={editorTabs} onAttach={attachToChat} />
              </div>
            </>
          )}

          <div className={editorMaximized ? "hidden" : "contents"} data-right-panel-wrap>
          <RightPanel
            cwd={cwd}
            context={
              <ContextPanel
                state={state}
                config={config}
                onPolicy={onPolicy}
                onClear={() => void onClear()}
              />
            }
          />
          </div>
        </div>

        {fanoutOpen && <FanoutModal initialPrompt={loadComposerDraft(tabId)} defaultProvider={provider} onStart={startFanout} onClose={closeFanout} />}
        {orchPanel && <OrchestrationPanel initialRunId={orchPanel.runId} onClose={closeOrch} />}
        {compareFanoutId && (
          <FanoutCompare
            tabId={tabId}
            fanoutId={compareFanoutId}
            adoptedTabId={(state.blocks.find((b) => b.kind === "fanout" && b.id === compareFanoutId) as { adoptedTabId?: string } | undefined)?.adoptedTabId}
            onClose={closeCompare}
          />
        )}

        {modelPicker && config && (
          <ModelPickerModal
            provider={config.provider}
            current={config.model}
            onClose={() => setModelPicker(false)}
            onPick={setModel}
          />
        )}

        {switching && (
          <ProviderSwitchModal
            current={provider}
            running={running}
            onClose={() => setSwitching(false)}
            loadHandoff={loadHandoff}
            onSwitch={async (opts) => {
              setConfig(
                await window.workbench.chat.switchProvider(tabId, opts),
              );
            }}
          />
        )}

      </div>
    </LocateFileContext.Provider>
    </OpenFileContext.Provider>
  );
}

function statusDot(status: string): string {
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

/** 격리 세션 표시: 브랜치 이름 칩. 누르면 상태(ahead/dirty)와 "가져오기"·"정리" 메뉴. */
function WorktreeChip({
  tabId,
  worktree,
  running,
  onChanged,
}: {
  tabId: string;
  worktree: WorktreeMeta;
  running: boolean;
  onChanged: (snapshot: SessionSnapshotDto | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<WorktreeStatusDto | null>(null);
  const [busy, setBusy] = useState<"merge" | "remove" | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setStatus(null);
    window.workbench.worktree.status(tabId).then((s) => alive && setStatus(s));
    return () => {
      alive = false;
    };
  }, [open, tabId, msg]);
  const merge = async () => {
    setBusy("merge");
    const r = await window.workbench.worktree.merge(tabId);
    setBusy(null);
    setMsg(r.ok ? { ok: true, text: r.merged === 0 ? "가져올 커밋이 없습니다." : `${r.merged}개 커밋을 ${worktree.base} 로 가져왔습니다.` } : { ok: false, text: r.error });
  };
  const remove = async (force: boolean) => {
    setBusy("remove");
    const r = await window.workbench.worktree.remove(tabId, { force });
    setBusy(null);
    setConfirmRemove(false);
    if (r.ok) {
      setOpen(false);
      onChanged(await window.workbench.chat.snapshot(tabId));
    } else setMsg({ ok: false, text: r.error });
  };
  return (
    <span className="relative shrink-0">
      <button
        onClick={() => setOpen((o) => !o)}
        className="no-drag flex items-center gap-1 rounded bg-accent-tint px-1.5 py-0.5 text-accent hover:bg-accent/15"
        title={`격리 세션 · ${worktree.branch}\n${worktree.path}`}
        data-worktree-chip
      >
        <Icon name="branch" size={10} />
        {worktree.branch.replace(/^atelier\//, "")}
      </button>
      {open && (
        <div
          className="no-drag absolute left-0 top-full z-30 mt-1 w-[320px] rounded-md border border-line bg-panel p-2 text-[11.5px] shadow-xl"
          data-worktree-menu
        >
          <div className="mono px-1 pb-1.5 text-[10.5px] text-muted">
            {worktree.branch} → {worktree.base}
            {status ? (
              <>
                {" · "}
                {status.exists ? (
                  <>
                    커밋 <span className="text-fg">{status.ahead}</span>개 앞
                    {status.behind > 0 && <>, {status.behind}개 뒤</>}
                    {status.dirty > 0 && <span className="text-warn"> · 미커밋 {status.dirty}</span>}
                  </>
                ) : (
                  <span className="text-err">worktree 폴더가 없습니다</span>
                )}
              </>
            ) : (
              " · 확인 중…"
            )}
          </div>
          <button
            onClick={() => void merge()}
            disabled={busy !== null || running || !status?.exists || status.ahead === 0 || status.dirty > 0}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2 disabled:opacity-40"
            title={status?.dirty ? "먼저 커밋하거나 버리세요" : `이 브랜치의 커밋을 ${worktree.base} 에 merge 합니다 (원본 저장소에서)`}
            data-worktree-merge
          >
            <Icon name="check" size={12} className="text-accent" />
            {busy === "merge" ? "가져오는 중…" : `변경 가져오기 (${worktree.base} 로 merge)`}
          </button>
          {!confirmRemove ? (
            <button
              onClick={() => setConfirmRemove(true)}
              disabled={busy !== null || running}
              className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-panel-2 disabled:opacity-40"
              title="worktree 폴더를 지우고 이 세션을 원본 저장소 경로로 되돌립니다"
              data-worktree-remove
            >
              <Icon name="trash" size={12} className="text-muted" />
              worktree 정리
            </button>
          ) : (
            <div className="mt-1 flex items-center gap-2 rounded-md border border-err/40 bg-err-bg px-2 py-1.5 text-err" data-worktree-confirm>
              <span className="min-w-0 flex-1">
                {status?.dirty ? `미커밋 변경 ${status.dirty}개가 사라집니다.` : "worktree 폴더를 지웁니다."}
                {status && status.ahead > 0 ? " 가져오지 않은 커밋은 브랜치에 남습니다." : ""}
              </span>
              <button
                onClick={() => void remove(Boolean(status?.dirty))}
                className="rounded bg-err px-2 py-0.5 font-medium text-white hover:opacity-90"
                data-worktree-confirm-yes
              >
                정리
              </button>
              <button onClick={() => setConfirmRemove(false)} className="rounded px-1.5 py-0.5 hover:bg-err/10">
                취소
              </button>
            </div>
          )}
          {msg && (
            <div className={`mono mt-1 px-1 text-[10.5px] ${msg.ok ? "text-ok" : "text-err"}`} data-worktree-msg>
              {msg.text}
            </div>
          )}
        </div>
      )}
    </span>
  );
}

/** 프롬프트 큐: 턴 진행 중에 써 둔 다음 지시들. 편집·삭제할 수 있고, 턴이 끝나면 위에서부터 자동 전송된다. */
function PendingQueue({
  tabId,
  items,
  idle,
  onChanged,
}: {
  tabId: string;
  items: PendingPromptDto[];
  /** 턴이 돌고 있지 않다(앱 재시작으로 복원됐거나 오류로 멈춘 뒤): 자동으로 나가지 않으니 "지금 보내기" 를 준다. */
  idle: boolean;
  onChanged: (snapshot: SessionSnapshotDto) => void;
}) {
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null);
  const save = async () => {
    if (!editing) return;
    onChanged(await window.workbench.chat.queueUpdate(tabId, editing.id, editing.text));
    setEditing(null);
  };
  return (
    <div className="mx-6 mb-2 rounded-md border border-line bg-panel px-3 py-2 text-[12px]" data-pending-queue>
      <div className="label mb-1 flex items-center gap-1.5 text-muted">
        <Icon name="clock" size={11} />
        {idle ? `대기 중인 지시 ${items.length} — 다음 턴이 끝나면 차례로 보냅니다` : `다음에 보낼 지시 ${items.length}`}
        {idle && (
          <button
            onClick={() => void window.workbench.chat.queueSendNext(tabId).then(onChanged)}
            className="ml-auto rounded border border-line px-1.5 py-0.5 text-[11px] text-fg hover:bg-panel-2"
            title="대기열 맨 앞 지시를 지금 보냅니다"
            data-pending-send-next
          >
            지금 보내기
          </button>
        )}
      </div>
      <ul className="flex flex-col gap-1">
        {items.map((p, i) => (
          <li key={p.id} className="flex items-start gap-2" data-pending-item>
            <span className="mono mt-0.5 w-4 shrink-0 text-muted-2">{i + 1}</span>
            {editing?.id === p.id ? (
              <textarea
                autoFocus
                value={editing.text}
                onChange={(e) => setEditing({ id: p.id, text: e.target.value })}
                onKeyDown={(e) => {
                  e.stopPropagation();
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    void save();
                  } else if (e.key === "Escape") setEditing(null);
                }}
                rows={2}
                className="min-w-0 flex-1 resize-none rounded border border-accent/50 bg-inset px-2 py-1 text-fg outline-none"
                style={{ userSelect: "text" }}
              />
            ) : (
              <button
                onClick={() => setEditing({ id: p.id, text: p.text })}
                className="min-w-0 flex-1 truncate rounded px-1 text-left text-fg hover:bg-panel-2"
                title={`${p.text}\n\n클릭해서 편집`}
              >
                {p.text || "(이미지)"}
                {p.hasImages && <span className="ml-1 text-muted">📎</span>}
              </button>
            )}
            <button
              onClick={() => void window.workbench.chat.queueRemove(tabId, p.id).then(onChanged)}
              className="shrink-0 rounded p-0.5 text-muted hover:bg-panel-2 hover:text-fg"
              title="큐에서 빼기"
              data-pending-remove
            >
              <Icon name="x" size={11} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** 사용 한도 도달: 리셋 시각까지 남은 시간을 세며 자동 재시도를 알리고, 지금 재시도·취소를 준다. */
function LimitWaitBanner({
  tabId,
  wait,
  onChanged,
}: {
  tabId: string;
  wait: LimitWaitDto;
  onChanged: (snapshot: SessionSnapshotDto) => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, []);
  const remainMin = wait.until ? Math.max(0, Math.ceil((wait.until - now) / 60_000)) : null;
  const at = wait.until ? new Date(wait.until).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" }) : null;
  return (
    <div
      className="mx-6 mb-2 flex items-center gap-2 rounded-md border border-warn/40 bg-warn-bg px-3 py-2 text-[12px] text-warn"
      data-limit-banner
    >
      <Icon name="clock" size={13} className="shrink-0" />
      <span className="min-w-0 flex-1 truncate" title={wait.message}>
        사용 한도에 도달했습니다.{" "}
        {at
          ? `${at} 에 자동으로 다시 시도합니다 (약 ${remainMin}분 후${wait.attempts > 1 ? `, ${wait.attempts}번째` : ""}).`
          : "리셋 시각을 알 수 없어 자동 재시도는 예약하지 않았습니다."}
      </span>
      <button
        onClick={() => void window.workbench.chat.limitRetryNow(tabId).then(onChanged)}
        className="shrink-0 rounded border border-warn/40 px-2 py-0.5 hover:bg-warn/10"
        data-limit-retry
      >
        지금 재시도
      </button>
      <button
        onClick={() => void window.workbench.chat.limitCancel(tabId).then(onChanged)}
        className="shrink-0 rounded p-0.5 hover:bg-fg/5"
        title="재시도 취소"
        data-limit-cancel
      >
        <Icon name="x" size={12} />
      </button>
    </div>
  );
}
