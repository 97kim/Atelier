import { useCallback, useEffect, useState } from "react";
import type { AppInfoDto, ShortcutName } from "@shared/ipc";
import { activeWorkspace, tabCwd } from "@shared/workspace-model";
import { Icon } from "./components/Icon";
import { Sidebar, type View } from "./components/Sidebar";
import { WorkspaceSwitcher } from "./components/WorkspaceSwitcher";
import { SearchPalette } from "./components/SearchPalette";
import { kvGet, kvSet } from "./kv-store";
import { requestReveal } from "./reveal";
import { browserHasKeys } from "./browser-active";
import { closeTarget } from "./close-target";
import { isBrowserTab } from "./editor-tabs";
import { forgetEditorTabs, getEditorTabs, getLastPane, openBrowserTab, openEditorFile, pruneEditorTabs, reopenClosedEditorTab, setEditorMaximized } from "./editor-tabs";
import { clearComposerDraft, pruneComposerDrafts } from "./composer-draft";
import { nextAttentionTab } from "@shared/attention-nav";
import { useWorkspaces } from "./hooks/useWorkspaces";
import { ChatView } from "./views/ChatView";
import { SettingsView, type SettingsSection } from "./views/SettingsView";
import { UsageView } from "./views/UsageView";

export function App() {
  const [view, setView] = useState<View>("chat");
  // 사이드바 접힘. 아주 없애지 않고 얇은 띠로 두는 이유는 macOS 신호등 버튼 자리를 지켜야 해서다.
  const [railed, setRailed] = useState(() => kvGet("sidebar.railed") === "1");
  const toggleRail = useCallback(
    () => setRailed((v) => {
      kvSet("sidebar.railed", v ? null : "1");
      return !v;
    }),
    [],
  );
  const [settingsSection, setSettingsSection] =
    useState<SettingsSection>("general");
  const [info, setInfo] = useState<AppInfoDto | null>(null);
  const [switcher, setSwitcher] = useState(false);
  const [search, setSearch] = useState(false);
  // 짧은 알림(오류 등). 몇 초 뒤 사라진다.
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.error ? 6000 : 3000);
    return () => clearTimeout(t);
  }, [notice]);
  const ws = useWorkspaces();
  const api = window.workbench.workspaces;

  useEffect(() => {
    window.workbench.app.info().then(setInfo).catch(console.error);
  }, []);

  const { model } = ws;
  const activeTab = model.tabs.find((t) => t.id === model.activeTabId) ?? null;
  const activeWs = activeTab
    ? (model.workspaces.find((w) => w.id === activeTab.workspaceId) ?? null)
    : null;

  const newTab = useCallback(async () => {
    const wsId = activeWorkspace(model)?.id;
    if (!wsId) {
      await api.create("새 워크스페이스");
      setView("chat");
      return;
    }
    await api.createTab(wsId);
    setView("chat");
  }, [model, api]);

  const openTab = useCallback(
    async (tabId: string) => {
      const tab = model.tabs.find((t) => t.id === tabId);
      if (!tab) return;
      if (tab.open) await api.activateTab(tabId);
      else await api.reopenTab(tabId);
      setView("chat");
    },
    [model, api],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      await api.closeTab(tabId);
    },
    [api],
  );

  // 삭제된 탭의 입력창 초안·에디터 상태를 정리한다(삭제가 어느 경로로 일어났든). 모델이 아직 비어 있으면(로딩 전) 건드리지 않는다.
  useEffect(() => {
    if (model.tabs.length === 0) return;
    const live = new Set(model.tabs.map((t) => t.id));
    pruneEditorTabs(live);
    pruneComposerDrafts(live);
  }, [model.tabs]);

  const newWorktreeIn = useCallback(
    async (wsId: string) => {
      const active = model.tabs.find((t) => t.id === model.activeTabId);
      const r = await window.workbench.worktree.create(wsId, active?.workspaceId === wsId ? active.id : null);
      if (r.ok) setView("chat");
      else setNotice({ text: r.error, error: true });
    },
    [model.tabs, model.activeTabId],
  );

  // 응답 필요(권한 대기·미확인 완료) 세션으로 점프. 열린 탭 순서로 순환.
  const jumpAttention = useCallback(
    (dir: 1 | -1) => {
      const id = nextAttentionTab(model.openTabIds, ws.attention, model.activeTabId, dir);
      if (id) void openTab(id);
    },
    [model.openTabIds, model.activeTabId, ws.attention, openTab],
  );

  // `atelier` CLI 가 밀어 넣는 화면 동작: 그 탭으로 가서 파일·브라우저를 연다
  useEffect(
    () =>
      window.workbench.app.onControlOpen((req) => {
        setView("chat"); // 설정·사용량 화면에 있어도 요청한 탭이 보이게
        void api.activateTab(req.tabId);
        if (req.kind === "file") openEditorFile(req.tabId, req.path, req.line ? { line: req.line } : null);
        else openBrowserTab(req.tabId, req.url);
      }),
    [],
  );

  // 메뉴 단축키 (⌘T/⌘W/⌘K/⌘1~9/⌃Tab)
  useEffect(() => {
    /** 지금 브라우저를 보고 있나 — ⌘F·⌘L·⌘R 을 그쪽으로 보낼지 판단한다. */
    const browserKeysActive = () => {
      const tabId = model.activeTabId;
      if (!tabId) return false;
      const t = getEditorTabs(tabId);
      return browserHasKeys({
        editorShown: t.visible && t.files.length > 0,
        editorMaximized: t.maximized,
        focusInEditor: !!document.activeElement?.closest?.("[data-editor-pane-shell]"),
        lastPane: getLastPane(tabId),
        hasEditorTab: !!t.active,
        activeIsBrowser: !!t.active && isBrowserTab(t.active),
      });
    };
    const handle = (name: ShortcutName) => {
      if (name === "new-tab") void newTab();
      else if (name === "close-tab" && model.activeTabId) {
        const tabId = model.activeTabId;
        const t = getEditorTabs(tabId);
        // 포커스가 에디터 패널 안이면(CodeMirror·브라우저 webview·도구막대) 그 탭을 닫는다.
        // webview 안을 클릭하면 호스트의 activeElement 가 그 <webview> 요소가 되므로 이 검사로 잡힌다.
        const focusInEditor = !!document.activeElement?.closest?.("[data-editor-pane-shell]");
        const where = closeTarget({
          editorShown: t.visible && t.files.length > 0,
          editorMaximized: t.maximized,
          focusInEditor,
          lastPane: getLastPane(tabId),
          hasEditorTab: !!t.active,
        });
        if (where === "editor") window.dispatchEvent(new CustomEvent("atelier:editor-close-active", { detail: tabId }));
        else void closeTab(tabId);
      }
      else if (name === "toggle-sidebar") toggleRail();
      else if (name === "switch-workspace") setSwitcher((s) => !s);
      else if (name === "search") {
        // ⌘F: 브라우저를 보고 있으면 그 페이지에서 찾기, 아니면 대화 검색
        if (browserKeysActive()) window.dispatchEvent(new CustomEvent("atelier:browser-command", { detail: "find" }));
        else setSearch((s) => !s);
      } else if (name === "reopen-tab") {
        if (model.activeTabId) reopenClosedEditorTab(model.activeTabId);
      } else if (name === "browser-address" || name === "browser-reload" || name === "browser-hard-reload") {
        if (browserKeysActive())
          window.dispatchEvent(
            new CustomEvent("atelier:browser-command", {
              detail: name === "browser-address" ? "address" : name === "browser-hard-reload" ? "hard-reload" : "reload",
            }),
          );
      }
      else if (name === "toggle-editor-maximize" && model.activeTabId) {
        const t = getEditorTabs(model.activeTabId);
        // 열린 파일이 없으면 넓힐 것도 없다
        if (t.files.length > 0) setEditorMaximized(model.activeTabId, !t.maximized);
      }
      else if (name === "next-attention" || name === "prev-attention")
        jumpAttention(name === "next-attention" ? 1 : -1);
      else if (name === "next-tab" || name === "prev-tab") {
        const ids = model.openTabIds;
        if (ids.length === 0) return;
        const i = ids.indexOf(model.activeTabId ?? "");
        const next =
          name === "next-tab"
            ? (i + 1) % ids.length
            : (i - 1 + ids.length) % ids.length;
        void api.activateTab(ids[next]);
        setView("chat");
      } else if (name.startsWith("tab-")) {
        const id = model.openTabIds[Number(name.slice(4)) - 1];
        if (id) {
          void api.activateTab(id);
          setView("chat");
        }
      }
    };
    // 네이티브 메뉴 가속기는 자동화로 못 누른다 — e2e 가 같은 경로를 타도록 열어 둔다.
    void 0;
    (window as unknown as { __atelierShortcut?: (n: ShortcutName) => void }).__atelierShortcut = handle;
    return window.workbench.app.onShortcut(handle);
  }, [model, newTab, closeTab, api]);

  return (
    <div className="relative flex h-full">
      <Sidebar
        railed={railed}
        onToggleRail={toggleRail}
        view={view}
        onView={setView}
        ws={ws}
        info={info}
        onNewTab={() => void newTab()}
        onOpenTab={(id) => void openTab(id)}
        onNewTabIn={(wsId) =>
          void api.createTab(wsId).then(() => setView("chat"))
        }
        onRemoveWorkspace={(wsId) => void api.remove(wsId)}
        onCloseTab={(id) => void closeTab(id)}
        onRenameTab={(id, title) => void api.renameTab(id, title)}
        onReorderTabs={(ids) => void api.reorderTabs(ids)}
        onReorderWorkspaces={(ids) => void api.reorderWorkspaces(ids)}
        onDeleteTab={(id) =>
          void api.deleteTab(id).then((r) => {
            if (r.ok) {
              forgetEditorTabs(id);
              clearComposerDraft(id);
            }
            else setNotice({ text: r.error, error: true });
          })
        }
        onCreateWorkspace={(name) =>
          void api.create(name).then(() => setView("chat"))
        }
        onRenameWorkspace={(id, name) => void api.update(id, { name })}
        onSetWorkspacePath={(id) =>
          void window.workbench.dialog.pickDirectory().then((dir) => {
            if (dir) void api.update(id, { path: dir });
          })
        }
        onClearWorkspacePath={(id) => void api.update(id, { path: "" })}
        onSwitchWorkspace={() => setSwitcher(true)}
        onSearch={() => setSearch(true)}
        onJumpAttention={() => jumpAttention(1)}
        onNewWorktreeIn={(wsId) => void newWorktreeIn(wsId)}
        onExportTab={(id) => void window.workbench.chat.exportMarkdown(id)}
      />

      <main className="flex min-w-0 flex-1 flex-col">
        {view === "chat" && (
          <>
            <div className="min-h-0 flex-1">
              {activeTab && activeWs ? (
                <ChatView
                  key={activeTab.id}
                  tab={activeTab}
                  workspace={activeWs}
                  ws={ws}
                  onActivateTab={(id) => void api.activateTab(id)}
                  onCloseTab={(id) => void closeTab(id)}
                  onNewTab={() => void newTab()}
                  onOpenMcp={() => {
                    setSettingsSection("mcp");
                    setView("settings");
                  }}
                  onOpenSettings={(section) => {
                    setSettingsSection(section ?? "cli");
                    setView("settings");
                  }}
                  onIsolate={() => void newWorktreeIn(activeWs.id)}
                />
              ) : (
                <EmptyState
                  hasWorkspace={model.workspaces.length > 0}
                  onAdd={() =>
                    void api
                      .create("새 워크스페이스")
                      .then(() => setView("chat"))
                  }
                  onNew={() => void newTab()}
                />
              )}
            </div>
          </>
        )}
        {view === "settings" && (
          <SettingsView
            info={info}
            workspaces={model.workspaces.map((w) => ({ id: w.id, name: w.name }))}
            // MCP 상태는 Claude 가 실제로 도는 디렉토리 기준 — 활성 세션의 cwd 를 먼저, 없으면 워크스페이스 기본 경로.
            workspacePath={
              (activeTab && tabCwd(model, activeTab)) ||
              activeWs?.path ||
              model.tabs.find((t) => t.workspaceId === activeWs?.id && t.cwd)?.cwd ||
              null
            }
            section={settingsSection}
            onSection={setSettingsSection}
          />
        )}
        {view === "usage" && <UsageView />}
      </main>

      {notice && (
        <div
          className={`pointer-events-none absolute bottom-4 left-1/2 z-50 -translate-x-1/2 rounded-md border px-3 py-2 text-[12px] shadow-lg ${
            notice.error ? "border-err/40 bg-err-bg text-err" : "border-line bg-panel text-fg"
          }`}
          data-notice
        >
          {notice.text}
        </div>
      )}
      {search && (
        <SearchPalette
          onClose={() => setSearch(false)}
          onPick={(tabId, blockId) => {
            setSearch(false);
            // 먼저 예약해 두면 그 탭의 MessageList 가 (이미 있든, 새로 마운트되든) 블록이 생기는 순간 이동한다.
            requestReveal(tabId, blockId);
            void openTab(tabId);
          }}
        />
      )}
      {switcher && (
        <WorkspaceSwitcher
          ws={ws}
          onClose={() => setSwitcher(false)}
          onPick={(id) => {
            setSwitcher(false);
            void api.createTab(id).then(() => setView("chat"));
          }}
          onAdd={(name) => {
            setSwitcher(false);
            void api
              .create(name || "새 워크스페이스")
              .then(() => setView("chat"));
          }}
          onRemove={(id) => void api.remove(id)}
        />
      )}
    </div>
  );
}

function EmptyState({
  hasWorkspace,
  onAdd,
  onNew,
}: {
  hasWorkspace: boolean;
  onAdd: () => void;
  onNew: () => void;
}) {
  return (
    <div className="drag flex h-full flex-col items-center justify-center gap-4 text-center">
      <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-panel text-accent">
        <Icon name="folder" size={22} />
      </div>
      <div>
        <div className="text-[15px] font-semibold">
          {hasWorkspace ? "열린 세션이 없습니다" : "워크스페이스를 추가하세요"}
        </div>
        <p className="mt-1 text-muted">
          {hasWorkspace
            ? "새 세션을 열거나 왼쪽 최근 목록에서 이전 세션을 다시 여세요."
            : "워크스페이스는 업무 단위 이름표입니다. 만든 뒤 세션마다 작업 경로를 고르면 그 안에서 Claude Code / Codex 가 실행됩니다."}
        </p>
      </div>
      <button
        onClick={hasWorkspace ? onNew : onAdd}
        className="no-drag flex items-center gap-2 rounded-md bg-primary px-4 py-2 font-medium text-on-primary hover:bg-primary-hover"
      >
        <Icon name={hasWorkspace ? "edit" : "folder"} size={14} />
        {hasWorkspace ? "새 세션 (⌘T)" : "워크스페이스 만들기"}
      </button>
    </div>
  );
}
