import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionStatus } from "@shared/chat-events";
import type { AppInfoDto, WorkspaceStateDto, SessionAttention } from "@shared/ipc";
import {
  tabTitle,
  workspaceTabs,
  type TabMeta,
  type Workspace,
} from "@shared/workspace-model";
import { Icon } from "./Icon";
import { ProviderLogo } from "./ProviderLogo";
import { Logo } from "./Logo";
import { SidebarLimits } from "./SidebarLimits";
import { StatusDot } from "./StatusDot";

export type View = "chat" | "usage" | "settings";

const NAV: { id: View; label: string; icon: "chat" | "usage" | "settings" }[] =
  [
    { id: "chat", label: "채팅", icon: "chat" },
    { id: "usage", label: "사용량", icon: "usage" },
    { id: "settings", label: "설정", icon: "settings" },
  ];

/** 워크스페이스마다 닫힌 세션은 이만큼만. 그 아래는 "n개 더" 로 접는다. */
const CLOSED_LIMIT = 12;
const COLLAPSED_KEY = "workbench.sidebar.collapsed";

type Menu =
  | { kind: "tab"; id: string; x: number; y: number }
  | { kind: "ws"; id: string; x: number; y: number };

/**
 * 좌측 패널 = 워크스페이스 트리. 워크스페이스 행 아래에 그 워크스페이스의 세션(탭)들이 붙는다.
 * 열린 세션은 탭바 순서, 닫힌 세션은 흐리게 최근 순. 행에 마우스를 올리면 × (열린 세션은 닫기, 닫힌 세션은 삭제).
 */
export function Sidebar({
  view,
  onView,
  ws,
  info,
  onNewTab,
  onNewTabIn,
  onOpenTab,
  onCloseTab,
  onRenameTab,
  onDeleteTab,
  onCreateWorkspace,
  onRenameWorkspace,
  onSetWorkspacePath,
  onClearWorkspacePath,
  onRemoveWorkspace,
  onSwitchWorkspace,
  onSearch,
  onExportTab,
  onJumpAttention,
  onNewWorktreeIn,
}: {
  view: View;
  onView: (v: View) => void;
  ws: WorkspaceStateDto;
  info: AppInfoDto | null;
  onNewTab: () => void;
  /** ⌘F 대화 검색 팔레트. */
  onSearch: () => void;
  /** 응답 필요 세션(권한 대기·미확인 완료)으로 점프 (⌘⇧↓). */
  onJumpAttention: () => void;
  /** 세션을 마크다운 파일로 내보내기(저장 다이얼로그). */
  onExportTab: (tabId: string) => void;
  onNewTabIn: (workspaceId: string) => void;
  /** 격리 세션: 브랜치 + git worktree 를 만들어 그 경로에서 새 세션을 연다. */
  onNewWorktreeIn: (workspaceId: string) => void;
  onOpenTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onRenameTab: (tabId: string, title: string) => void;
  onDeleteTab: (tabId: string) => void;
  onCreateWorkspace: (name: string) => void;
  onRenameWorkspace: (workspaceId: string, name: string) => void;
  /** 디렉토리 선택 다이얼로그를 띄워 기본 경로를 정한다. */
  onSetWorkspacePath: (workspaceId: string) => void;
  onClearWorkspacePath: (workspaceId: string) => void;
  onRemoveWorkspace: (workspaceId: string) => void;
  onSwitchWorkspace: () => void;
}) {
  const { model, statuses, attention } = ws;
  const attentionCount = model.openTabIds.filter((id) => attention[id]).length;
  const activeTab = model.tabs.find((t) => t.id === model.activeTabId) ?? null;
  const activeWs: Workspace | null =
    (activeTab &&
      model.workspaces.find((w) => w.id === activeTab.workspaceId)) ??
    [...model.workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt)[0] ??
    null;
  const workspaces = useMemo(
    () => [...model.workspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt),
    [model.workspaces],
  );

  // 워크스페이스 접힘 상태 (저장).
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      const raw = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? "[]");
      return new Set(
        Array.isArray(raw) ? raw.filter((x) => typeof x === "string") : [],
      );
    } catch {
      return new Set();
    }
  });
  const toggleCollapsed = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      try {
        localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...next]));
      } catch {
        /* 무시 */
      }
      return next;
    });
  const [showAllClosed, setShowAllClosed] = useState<Set<string>>(new Set());
  // 워크스페이스 만들기(이름 입력 행) · 워크스페이스 이름 변경(행 안에서).
  const [creating, setCreating] = useState(false);
  const [createDraft, setCreateDraft] = useState("");
  const [renamingWs, setRenamingWs] = useState<{
    id: string;
    draft: string;
  } | null>(null);
  const wsRenameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renamingWs) wsRenameRef.current?.select();
  }, [renamingWs?.id]);
  const commitCreate = () => {
    const name = createDraft.trim();
    setCreating(false);
    setCreateDraft("");
    if (name) onCreateWorkspace(name);
  };
  const commitWsRename = () => {
    if (!renamingWs) return;
    const w = model.workspaces.find((x) => x.id === renamingWs.id);
    if (w && renamingWs.draft.trim() && renamingWs.draft.trim() !== w.name)
      onRenameWorkspace(w.id, renamingWs.draft);
    setRenamingWs(null);
  };

  // 우클릭 메뉴 + 행 안에서 하는 이름 변경·삭제/제거 확인.
  const [menu, setMenu] = useState<Menu | null>(null);
  const [renaming, setRenaming] = useState<{
    tabId: string;
    draft: string;
  } | null>(null);
  const [confirm, setConfirm] = useState<{
    kind: "tab" | "ws";
    id: string;
  } | null>(null);
  const renameRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (renaming) renameRef.current?.select();
  }, [renaming?.tabId]);
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", onKey);
    window.addEventListener("blur", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("blur", close);
    };
  }, [menu]);
  const commitRename = () => {
    if (!renaming) return;
    const tab = model.tabs.find((t) => t.id === renaming.tabId);
    if (tab && renaming.draft.trim() !== (tab.title ?? "").trim())
      onRenameTab(renaming.tabId, renaming.draft);
    setRenaming(null);
  };
  const menuTab =
    menu?.kind === "tab" ? model.tabs.find((t) => t.id === menu.id) : null;
  const menuWs =
    menu?.kind === "ws" ? model.workspaces.find((w) => w.id === menu.id) : null;
  const openMenu = (e: React.MouseEvent, m: Menu) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu(m);
  };

  return (
    <aside className="drag flex w-[248px] shrink-0 flex-col bg-panel">
      <div className="flex items-center gap-2.5 px-4 pb-3 pt-11">
        <Logo size={22} className="text-fg" />
        <span className="text-[14px] font-semibold tracking-wide">Atelier</span>
        <span className="label ml-auto rounded bg-panel-2 px-1.5 py-0.5">
          LOCAL
        </span>
      </div>

      <nav className="no-drag flex gap-0.5 px-3 pb-3">
        {NAV.map((item) => (
          <button
            key={item.id}
            onClick={() => onView(item.id)}
            title={item.label}
            className={`flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-[12px] transition-colors ${
              view === item.id
                ? "bg-panel-2 text-fg"
                : "text-muted hover:bg-panel-2/60 hover:text-fg"
            }`}
          >
            <Icon name={item.icon} size={13} />
            {item.label}
          </button>
        ))}
      </nav>

      <div className="no-drag px-3">
        <button
          onClick={activeWs ? onNewTab : () => setCreating(true)}
          className="flex w-full items-center gap-2 rounded-md bg-primary px-3 py-2 font-medium text-on-primary hover:bg-primary-hover"
          title={
            activeWs ? `${activeWs.name} 에 새 세션 (⌘T)` : "워크스페이스 추가"
          }
        >
          <Icon name="edit" size={14} strokeWidth={2} />
          <span className="flex-1 text-left">
            {activeWs ? "새 세션" : "워크스페이스 추가"}
          </span>
          {activeWs && <kbd className="mono text-[10px] opacity-70">⌘T</kbd>}
        </button>
        <button
          onClick={onSearch}
          className="mt-1.5 flex w-full items-center gap-2 rounded-md px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg"
          title="모든 세션의 대화 내용 검색 (⌘F)"
          data-search-button
        >
          <Icon name="search" size={13} />
          <span className="flex-1 text-left">대화 검색</span>
          <kbd className="mono text-[10px] opacity-70">⌘F</kbd>
        </button>
        {attentionCount > 0 && (
          <button
            onClick={onJumpAttention}
            className="mt-1 flex w-full items-center gap-2 rounded-md bg-warn-bg px-3 py-1.5 text-warn hover:brightness-95"
            title="응답이 필요한 세션(권한 대기·확인 안 한 완료)으로 이동 (⌘⇧↓, 이전은 ⌘⇧↑)"
            data-attention-jump
          >
            <Icon name="alert" size={13} />
            <span className="flex-1 text-left">응답 필요 {attentionCount}</span>
            <kbd className="mono text-[10px] opacity-70">⌘⇧↓</kbd>
          </button>
        )}
      </div>

      <div
        className="no-drag mt-4 min-h-0 flex-1 overflow-y-auto px-3 pb-3"
        data-workspace-tree
      >
        <div className="label mb-1 flex items-center justify-between px-1">
          <span>워크스페이스</span>
          <span className="flex items-center gap-0.5">
            <button
              onClick={onSwitchWorkspace}
              className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
              title="워크스페이스 전환 (⌘K)"
            >
              <Icon name="search" size={11} />
            </button>
            <button
              onClick={() => setCreating(true)}
              className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
              title="워크스페이스 추가…"
            >
              <Icon name="plus" size={12} />
            </button>
          </span>
        </div>
        {creating && (
          <div className="mb-1.5 flex items-center gap-1.5 rounded-md border border-accent/50 bg-panel px-2 py-1.5">
            <Icon name="folder" size={13} className="shrink-0 text-accent" />
            <input
              autoFocus
              value={createDraft}
              onChange={(e) => setCreateDraft(e.target.value)}
              onBlur={commitCreate}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") commitCreate();
                else if (e.key === "Escape") {
                  setCreating(false);
                  setCreateDraft("");
                }
              }}
              placeholder="워크스페이스 이름 (업무 단위)"
              className="min-w-0 flex-1 bg-transparent text-fg outline-none"
              style={{ userSelect: "text" }}
              data-ws-create
            />
          </div>
        )}
        {workspaces.length === 0 && !creating && (
          <p className="px-1 text-muted">
            워크스페이스는 업무 단위 이름표입니다. 만들고 나서 세션마다 작업
            경로를 고릅니다.
          </p>
        )}

        {workspaces.map((w) => {
          const tabs = workspaceTabs(model, w.id);
          const openCount = tabs.filter((t) => t.open).length;
          const isCollapsed = collapsed.has(w.id);
          const isActiveWs = activeWs?.id === w.id;
          const closedTabs = tabs.filter((t) => !t.open);
          const hiddenClosed = showAllClosed.has(w.id)
            ? 0
            : Math.max(0, closedTabs.length - CLOSED_LIMIT);
          const visible =
            hiddenClosed > 0 ? tabs.slice(0, tabs.length - hiddenClosed) : tabs;
          return (
            <div key={w.id} className="mb-1.5" data-workspace={w.id}>
              {confirm?.kind === "ws" && confirm.id === w.id ? (
                <ConfirmRow
                  text="세션 기록까지 제거할까요?"
                  action="제거"
                  onYes={() => {
                    setConfirm(null);
                    onRemoveWorkspace(w.id);
                  }}
                  onNo={() => setConfirm(null)}
                />
              ) : (
                <div
                  onClick={() => toggleCollapsed(w.id)}
                  onContextMenu={(e) =>
                    openMenu(e, {
                      kind: "ws",
                      id: w.id,
                      x: e.clientX,
                      y: e.clientY,
                    })
                  }
                  className={`group flex cursor-default items-center gap-1.5 rounded-md py-1.5 pl-1 pr-1 ${
                    menu?.kind === "ws" && menu.id === w.id
                      ? "bg-panel-2"
                      : "hover:bg-panel-2/60"
                  }`}
                  onDoubleClick={() =>
                    setRenamingWs({ id: w.id, draft: w.name })
                  }
                  title={
                    w.path
                      ? `기본 경로 ${w.path}`
                      : "기본 경로 없음 · 세션 헤더에서 작업 경로를 고릅니다"
                  }
                >
                  <Icon
                    name="chevronRight"
                    size={11}
                    className={`shrink-0 text-muted transition-transform ${isCollapsed ? "" : "rotate-90"}`}
                  />
                  <Icon
                    name="folder"
                    size={13}
                    className={`shrink-0 ${isActiveWs ? "text-accent" : "text-muted"}`}
                  />
                  {renamingWs?.id === w.id ? (
                    <input
                      ref={wsRenameRef}
                      value={renamingWs.draft}
                      onChange={(e) =>
                        setRenamingWs({ id: w.id, draft: e.target.value })
                      }
                      onBlur={commitWsRename}
                      onClick={(e) => e.stopPropagation()}
                      onKeyDown={(e) => {
                        e.stopPropagation();
                        if (e.key === "Enter") commitWsRename();
                        else if (e.key === "Escape") setRenamingWs(null);
                      }}
                      placeholder="워크스페이스 이름"
                      className="-mx-1 min-w-0 flex-1 rounded border border-accent/50 bg-panel px-1 font-medium text-fg outline-none"
                      style={{ userSelect: "text" }}
                    />
                  ) : (
                    <span
                      className={`min-w-0 flex-1 truncate font-medium ${isActiveWs ? "text-fg" : "text-fg/80"}`}
                    >
                      {w.name}
                    </span>
                  )}
                  {openCount > 0 && (
                    <span className="label shrink-0 text-muted-2 group-hover:hidden">
                      {openCount}
                    </span>
                  )}
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onNewTabIn(w.id);
                    }}
                    className="hidden shrink-0 rounded p-0.5 text-muted hover:bg-panel hover:text-fg group-hover:block"
                    title="이 워크스페이스에 새 세션"
                    data-ws-new
                  >
                    <Icon name="plus" size={12} />
                  </button>
                </div>
              )}

              {!isCollapsed && (
                <ul className="ml-3 flex flex-col gap-px border-l border-line pl-1.5">
                  {tabs.length === 0 && (
                    <li className="px-2 py-1 text-[11px] text-muted-2">
                      세션 없음
                    </li>
                  )}
                  {visible.map((tab) => (
                    <li key={tab.id}>
                      {confirm?.kind === "tab" && confirm.id === tab.id ? (
                        <ConfirmRow
                          text="기록까지 삭제할까요?"
                          action="삭제"
                          onYes={() => {
                            setConfirm(null);
                            onDeleteTab(tab.id);
                          }}
                          onNo={() => setConfirm(null)}
                        />
                      ) : (
                        <SessionRow
                          tab={tab}
                          status={statuses[tab.id] ?? "idle"}
                          attention={attention[tab.id] ?? null}
                          active={
                            tab.id === model.activeTabId && view === "chat"
                          }
                          highlighted={
                            menu?.kind === "tab" && menu.id === tab.id
                          }
                          renaming={
                            renaming?.tabId === tab.id ? renaming.draft : null
                          }
                          renameRef={renameRef}
                          onOpen={() => onOpenTab(tab.id)}
                          onStartRename={() =>
                            setRenaming({
                              tabId: tab.id,
                              draft: tab.title ?? "",
                            })
                          }
                          onRenameChange={(v) =>
                            setRenaming({ tabId: tab.id, draft: v })
                          }
                          onRenameCommit={commitRename}
                          onRenameCancel={() => setRenaming(null)}
                          onContextMenu={(e) =>
                            openMenu(e, {
                              kind: "tab",
                              id: tab.id,
                              x: e.clientX,
                              y: e.clientY,
                            })
                          }
                          onX={() =>
                            tab.open
                              ? onCloseTab(tab.id)
                              : setConfirm({ kind: "tab", id: tab.id })
                          }
                        />
                      )}
                    </li>
                  ))}
                  {hiddenClosed > 0 && (
                    <li>
                      <button
                        onClick={() =>
                          setShowAllClosed((s) => new Set(s).add(w.id))
                        }
                        className="px-2 py-1 text-[11px] text-muted hover:text-fg"
                      >
                        닫힌 세션 {hiddenClosed}개 더 보기
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
          );
        })}
      </div>

      {menu && (menuTab || menuWs) && (
        <div
          role="menu"
          data-session-menu
          onMouseDown={(e) => e.stopPropagation()}
          className="no-drag fixed z-50 min-w-[160px] rounded-lg border border-line bg-panel p-1 shadow-pop"
          style={{
            left: Math.min(menu.x, window.innerWidth - 180),
            top: Math.min(menu.y, window.innerHeight - 140),
          }}
        >
          {menuTab && (
            <>
              <MenuItem
                label={menuTab.open ? "닫기" : "열기"}
                onPick={() => {
                  setMenu(null);
                  if (menuTab.open) onCloseTab(menuTab.id);
                  else onOpenTab(menuTab.id);
                }}
              />
              <MenuItem
                label="이름 변경"
                onPick={() => {
                  setMenu(null);
                  setRenaming({
                    tabId: menuTab.id,
                    draft: menuTab.title ?? "",
                  });
                }}
              />
              <MenuItem
                label="마크다운으로 내보내기…"
                onPick={() => {
                  setMenu(null);
                  onExportTab(menuTab.id);
                }}
              />
              <div className="my-1 h-px bg-line" />
              <MenuItem
                label="삭제…"
                danger
                onPick={() => {
                  setMenu(null);
                  setConfirm({ kind: "tab", id: menuTab.id });
                }}
              />
            </>
          )}
          {menuWs && (
            <>
              <MenuItem
                label="새 세션"
                onPick={() => {
                  setMenu(null);
                  onNewTabIn(menuWs.id);
                }}
              />
              <MenuItem
                label="격리 세션 (git worktree)"
                onPick={() => {
                  setMenu(null);
                  onNewWorktreeIn(menuWs.id);
                }}
              />
              <MenuItem
                label={collapsed.has(menuWs.id) ? "펼치기" : "접기"}
                onPick={() => {
                  setMenu(null);
                  toggleCollapsed(menuWs.id);
                }}
              />
              <MenuItem
                label="이름 변경"
                onPick={() => {
                  setMenu(null);
                  setRenamingWs({ id: menuWs.id, draft: menuWs.name });
                }}
              />
              <MenuItem
                label={menuWs.path ? "기본 경로 변경…" : "기본 경로 설정…"}
                onPick={() => {
                  setMenu(null);
                  onSetWorkspacePath(menuWs.id);
                }}
              />
              {menuWs.path && (
                <MenuItem
                  label="기본 경로 해제"
                  onPick={() => {
                    setMenu(null);
                    onClearWorkspacePath(menuWs.id);
                  }}
                />
              )}
              <div className="my-1 h-px bg-line" />
              <MenuItem
                label="워크스페이스 제거…"
                danger
                onPick={() => {
                  setMenu(null);
                  setConfirm({ kind: "ws", id: menuWs.id });
                }}
              />
            </>
          )}
        </div>
      )}

      <SidebarLimits onOpen={() => onView("usage")} />

      <div className="px-4 py-3">
        <div className="text-[12px] font-medium">{info?.userName ?? ""}</div>
        <div className="mono text-[10px] text-muted">
          {model.workspaces.length}개 워크스페이스{" "}
          {info ? `· v${info.version}` : ""}
        </div>
      </div>
    </aside>
  );
}

function SessionRow({
  tab,
  status,
  attention,
  active,
  highlighted,
  renaming,
  renameRef,
  onOpen,
  onStartRename,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
  onContextMenu,
  onX,
}: {
  tab: TabMeta;
  status: SessionStatus;
  attention: SessionAttention | null;
  active: boolean;
  highlighted: boolean;
  renaming: string | null;
  renameRef: React.RefObject<HTMLInputElement | null>;
  onOpen: () => void;
  onStartRename: () => void;
  onRenameChange: (v: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onX: () => void;
}) {
  return (
    <div
      onClick={onOpen}
      onDoubleClick={onStartRename}
      onContextMenu={onContextMenu}
      className={`group flex cursor-default items-center gap-2 rounded-md py-1.5 pl-2 pr-1 ${
        active || highlighted ? "bg-panel-2" : "hover:bg-panel-2/60"
      }`}
      data-session={tab.id}
      data-open={tab.open ? "true" : "false"}
    >
      <StatusDot
        status={tab.open ? status : "idle"}
        attention={tab.open ? attention : null}
        dim={!tab.open}
      />
      {renaming !== null ? (
        <input
          ref={renameRef}
          value={renaming}
          onChange={(e) => onRenameChange(e.target.value)}
          onBlur={onRenameCommit}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") onRenameCommit();
            else if (e.key === "Escape") onRenameCancel();
          }}
          placeholder="세션 이름"
          className="-mx-1 block min-w-0 flex-1 rounded border border-accent/50 bg-panel px-1 text-fg outline-none"
          style={{ userSelect: "text" }}
        />
      ) : (
        <span
          className={`min-w-0 flex-1 truncate ${
            tab.open
              ? attention
                ? "font-medium text-fg"
                : "text-fg"
              : "text-muted"
          }`}
        >
          {tabTitle(tab)}
        </span>
      )}
      <ProviderLogo provider={tab.provider} size={13} className="opacity-80 group-hover:hidden" />
      <button
        onClick={(e) => {
          e.stopPropagation();
          onX();
        }}
        className={`hidden shrink-0 rounded p-0.5 group-hover:block ${
          tab.open
            ? "text-muted hover:bg-panel hover:text-fg"
            : "text-muted hover:bg-err-bg hover:text-err"
        }`}
        title={tab.open ? "닫기" : "삭제…"}
        data-session-x
      >
        <Icon name="x" size={11} />
      </button>
    </div>
  );
}

function ConfirmRow({
  text,
  action,
  onYes,
  onNo,
}: {
  text: string;
  action: string;
  onYes: () => void;
  onNo: () => void;
}) {
  return (
    <div className="flex items-center gap-2 rounded-md bg-err-bg px-2 py-1.5 text-[12px] text-err">
      <span className="min-w-0 flex-1 truncate">{text}</span>
      <button
        onClick={onYes}
        className="rounded px-1.5 py-0.5 font-medium hover:bg-err/10"
      >
        {action}
      </button>
      <button
        onClick={onNo}
        className="rounded px-1.5 py-0.5 text-muted hover:bg-panel-2"
      >
        취소
      </button>
    </div>
  );
}

function MenuItem({
  label,
  onPick,
  danger,
}: {
  label: string;
  onPick: () => void;
  danger?: boolean;
}) {
  return (
    <button
      role="menuitem"
      onClick={onPick}
      className={`flex w-full items-center rounded-md px-2.5 py-1.5 text-left text-[12.5px] hover:bg-panel-2 ${danger ? "text-err" : "text-fg"}`}
    >
      {label}
    </button>
  );
}
