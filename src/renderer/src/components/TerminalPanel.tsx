// 채팅 아래 통합 터미널 패널. ⌘J 로 열고 닫는다. 패널 안에 터미널 탭이 여러 개 있고(셸 t1, t2 …), 하이브리드 모드의 CLI 는
// "cli" 탭으로 들어온다. 닫아도 xterm 은 숨김(hidden)으로 유지해 스크롤백이 남고, 프로세스는 main 이 "<채팅탭 id>:<이름>" 으로 들고 있다.
// 채팅 탭을 오가며 다시 마운트되면 main 의 목록과 백로그로 화면을 복원한다.

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import type { TerminalInfoDto } from "@shared/ipc";
import { Icon } from "./Icon";
import { onThemeChange } from "../theme";
import { formatTerminalAttachment } from "@shared/attachments";

const MIN_HEIGHT = 120;
const DEFAULT_HEIGHT = 260;

interface TermTab {
  id: string;
  kind: "shell" | "command";
  title: string;
}

export function TerminalPanel({
  tabId,
  cwd,
  open,
  onClose,
  onAttach,
}: {
  tabId: string;
  cwd: string;
  open: boolean;
  onClose: () => void;
  /** "채팅에 첨부": 활성 터미널의 선택 영역(없으면 최근 출력 40줄)을 입력창에 잇는다. */
  onAttach?: (block: string) => void;
}) {
  const terms = useRef(new Map<string, Terminal>());
  const attachActive = () => {
    if (!active || !onAttach) return;
    const term = terms.current.get(active);
    if (!term) return;
    const title = tabs.find((t) => t.id === active)?.title ?? "";
    onAttach(terminalAttachment(term, title));
  };
  const [height, setHeight] = useState(DEFAULT_HEIGHT);
  const [tabs, setTabs] = useState<TermTab[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const prefix = `${tabId}:`;

  // main 에 이미 떠 있는 터미널(채팅 탭 전환 전에 만든 것)을 복원한다. 없으면 셸 하나를 만든다.
  useEffect(() => {
    let alive = true;
    window.workbench.terminal.list(tabId).then((list) => {
      if (!alive) return;
      const restored = list.map((t) => ({
        id: t.id,
        kind: t.kind,
        title: t.title,
      }));
      if (restored.length === 0)
        restored.push({ id: `${prefix}t1`, kind: "shell", title: "셸" });
      setTabs(restored);
      setActive(
        restored.find((t) => t.kind === "command")?.id ??
          restored[restored.length - 1].id,
      );
      setLoaded(true);
    });
    const offOpened = window.workbench.terminal.onOpened(
      (info: TerminalInfoDto) => {
        if (!info.id.startsWith(prefix)) return;
        setTabs((prev) =>
          prev.some((t) => t.id === info.id)
            ? prev.map((t) =>
                t.id === info.id
                  ? { ...t, kind: info.kind, title: info.title }
                  : t,
              )
            : [...prev, { id: info.id, kind: info.kind, title: info.title }],
        );
        if (info.kind === "command") setActive(info.id);
      },
    );
    return () => {
      alive = false;
      offOpened();
    };
  }, [tabId, prefix]);

  const addTab = () => {
    const nums = tabs.map((t) => Number(/:t(\d+)$/.exec(t.id)?.[1] ?? 0));
    const id = `${prefix}t${Math.max(0, ...nums) + 1}`;
    setTabs((prev) => [...prev, { id, kind: "shell", title: "셸" }]);
    setActive(id);
  };

  const closeTab = (id: string) => {
    void window.workbench.terminal.close(id);
    setTabs((prev) => {
      const next = prev.filter((t) => t.id !== id);
      if (active === id) setActive(next[next.length - 1]?.id ?? null);
      return next;
    });
  };

  const closeAll = () => {
    for (const t of tabs) void window.workbench.terminal.close(t.id);
    setTabs([]);
    setActive(null);
    setLoaded(false);
    onClose();
    // 다음에 열면 셸 하나로 다시 시작
    setTimeout(() => {
      setTabs([{ id: `${prefix}t1`, kind: "shell", title: "셸" }]);
      setActive(`${prefix}t1`);
      setLoaded(true);
    }, 0);
  };

  // 드래그로 높이 조절 (패널 상단 가장자리).
  const onDragStart = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = height;
    const max = Math.max(MIN_HEIGHT, Math.floor(window.innerHeight * 0.7));
    const move = (ev: MouseEvent) =>
      setHeight(
        Math.min(max, Math.max(MIN_HEIGHT, startH + (startY - ev.clientY))),
      );
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  };

  return (
    <div
      className="no-drag relative shrink-0 border-t border-line bg-inset"
      style={{ height }}
      hidden={!open}
      data-terminal-panel
    >
      <div
        onMouseDown={onDragStart}
        className="absolute -top-1 left-0 right-0 z-10 h-2 cursor-row-resize"
      />
      <div className="flex h-8 items-center gap-1 px-2">
        <Icon name="terminal" size={12} className="ml-1 shrink-0 text-muted" />
        <div
          className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
          data-terminal-tabs
        >
          {tabs.map((t) => (
            <div
              key={t.id}
              onClick={() => setActive(t.id)}
              className={`group flex shrink-0 cursor-default items-center gap-1.5 rounded-md px-2 py-1 text-[11px] ${
                t.id === active
                  ? "bg-panel text-fg"
                  : "text-muted hover:bg-panel/60 hover:text-fg"
              }`}
              data-terminal-tab={t.id}
              data-active={t.id === active ? "true" : "false"}
            >
              {t.kind === "command" && (
                <Icon name="play" size={10} className="text-accent" />
              )}
              <span className="mono">{t.title}</span>
              <button
                onClick={(e) => {
                  e.stopPropagation();
                  closeTab(t.id);
                }}
                className="rounded p-0.5 text-muted opacity-0 hover:bg-panel-2 hover:text-err group-hover:opacity-100"
                title={t.kind === "command" ? "CLI 종료" : "셸 종료"}
              >
                <Icon name="x" size={10} />
              </button>
            </div>
          ))}
          <button
            onClick={addTab}
            className="shrink-0 rounded p-1 text-muted hover:bg-panel/60 hover:text-fg"
            title="새 터미널 탭"
          >
            <Icon name="plus" size={12} />
          </button>
        </div>
        <span
          className="mono hidden min-w-0 max-w-[38%] shrink truncate text-[10.5px] text-muted-2 sm:block"
          title={cwd}
        >
          {cwd.replace(/^\/Users\/[^/]+/, "~")}
        </span>
        <div className="flex shrink-0 items-center gap-0.5">
          {onAttach && (
            <button
              onClick={attachActive}
              className="mr-1 flex shrink-0 items-center gap-1 rounded px-1.5 py-1 text-[11px] text-muted hover:bg-panel-2 hover:text-fg"
              title="선택한 출력(없으면 최근 40줄)을 채팅 입력창에 넣습니다 (터미널 안에서 ⌘⇧A)"
              data-attach-chat-terminal
            >
              <Icon name="chat" size={11} />
              채팅에 첨부
            </button>
          )}
          <button
            onClick={onClose}
            className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg"
            title="패널 접기 (⌘J)"
          >
            <Icon name="minus" size={12} />
          </button>
          <button
            onClick={closeAll}
            className="rounded p-1 text-muted hover:bg-panel-2 hover:text-err"
            title="터미널 모두 종료하고 닫기"
          >
            <Icon name="x" size={12} />
          </button>
        </div>
      </div>
      <div className="absolute inset-x-0 bottom-0 top-8">
        {loaded &&
          tabs.map((t) => (
            <TerminalView
              key={t.id}
              termId={t.id}
              kind={t.kind}
              cwd={cwd}
              visible={open && t.id === active}
              onRegister={(term) => (term ? terms.current.set(t.id, term) : terms.current.delete(t.id))}
              onAttach={onAttach ? () => { const term = terms.current.get(t.id); if (term) onAttach(terminalAttachment(term, t.title)); } : undefined}
            />
          ))}
      </div>
    </div>
  );
}

/** 터미널 탭 하나 = xterm 하나. 보일 때 크기를 맞추고 pty 에 붙는다(없으면 셸을 띄운다). */
function TerminalView({
  termId,
  kind,
  cwd,
  visible,
  onRegister,
  onAttach,
}: {
  termId: string;
  kind: "shell" | "command";
  cwd: string;
  visible: boolean;
  onRegister?: (term: Terminal | null) => void;
  onAttach?: () => void;
}) {
  const cbs = useRef({ onRegister, onAttach });
  cbs.current = { onRegister, onAttach };
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [exit, setExit] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const attached = useRef(false);

  const spawn = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    setExit(null);
    setError(null);
    const r = await window.workbench.terminal.open(
      termId,
      cwd,
      term.cols,
      term.rows,
    );
    if (!r.ok) {
      setError(r.error ?? "셸을 시작하지 못했습니다.");
      return;
    }
    if (r.existing && r.backlog && !attached.current) {
      term.reset();
      term.write(r.backlog);
    }
    attached.current = true;
    term.focus();
  }, [termId, cwd]);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const theme = readTheme();
    const term = new Terminal({
      cursorBlink: true,
      // 셸 프롬프트(p10k 등)의 Nerd Font 기호가 네모로 깨지지 않게 Nerd Font 를 앞에 둔다. 없으면 앱 모노 폰트로.
      fontFamily: `"MesloLGS NF", "JetBrainsMono Nerd Font Mono", "Hack Nerd Font Mono", "Symbols Nerd Font Mono", ${theme.fontMono}`,
      fontSize: 12.5,
      lineHeight: 1.25,
      scrollback: 5000,
      macOptionIsMeta: true,
      allowProposedApi: true,
      theme: {
        background: theme.bg,
        foreground: theme.fg,
        cursor: theme.fg,
        cursorAccent: theme.bg,
        selectionBackground: theme.selection,
        selectionForeground: theme.fg,
      },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    termRef.current = term;
    fitRef.current = fit;
    cbs.current.onRegister?.(term);
    // ⌘⇧A: 터미널 안에서 바로 첨부(셸로는 안 보낸다)
    term.attachCustomKeyEventHandler((e) => {
      if (e.type === "keydown" && e.metaKey && e.shiftKey && e.code === "KeyA") {
        cbs.current.onAttach?.();
        return false;
      }
      return true;
    });
    const offData = window.workbench.terminal.onData((id, data) => {
      if (id !== termId) return;
      term.write(data);
      setExit(null); // 같은 id 에 새 프로세스가 붙었다
    });
    const offExit = window.workbench.terminal.onExit((id, code) => {
      if (id === termId) setExit(code);
    });
    const onInput = term.onData((data) =>
      window.workbench.terminal.write(termId, data),
    );
    const onResize = term.onResize(({ cols, rows }) =>
      window.workbench.terminal.resize(termId, cols, rows),
    );
    // 다크/라이트 전환: 토큰 값을 다시 읽어 xterm 색을 바꾼다(xterm 은 CSS 변수를 직접 못 쓴다)
    const offTheme = onThemeChange(() => {
      const t = readTheme();
      term.options.theme = {
        background: t.bg,
        foreground: t.fg,
        cursor: t.fg,
        cursorAccent: t.bg,
        selectionBackground: t.selection,
        selectionForeground: t.fg,
      };
    });
    return () => {
      offTheme();
      offData();
      offExit();
      onInput.dispose();
      onResize.dispose();
      cbs.current.onRegister?.(null);
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [termId]);

  useEffect(() => {
    if (!visible) return;
    const host = hostRef.current;
    const fit = fitRef.current;
    if (!host || !fit) return;
    const refit = () => {
      try {
        fit.fit();
      } catch {
        /* 아직 레이아웃 전 */
      }
    };
    refit();
    void spawn();
    const ro = new ResizeObserver(refit);
    ro.observe(host);
    return () => ro.disconnect();
  }, [visible, spawn]);

  return (
    <div
      className="absolute inset-0"
      hidden={!visible}
      data-terminal-view={termId}
    >
      <div ref={hostRef} className="absolute inset-0 px-2 pb-1" />
      {(exit !== null || error) && (
        <button
          onClick={() => void spawn()}
          className="absolute inset-0 flex items-center justify-center bg-inset/85 text-[12px] text-muted hover:text-fg"
        >
          {error
            ? `${error} · 클릭해서 다시 시도`
            : `${kind === "command" ? "CLI 가" : "셸이"} 종료되었습니다${exit !== null && exit >= 0 ? ` (code ${exit})` : ""} · 클릭하면 셸을 시작합니다`}
        </button>
      )}
    </div>
  );
}

/** CSS 토큰을 xterm 테마로. xterm 은 var() 를 못 읽어서 계산된 값을 넘긴다. */
function readTheme() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name: string, fallback: string) =>
    cs.getPropertyValue(name).trim() || fallback;
  return {
    bg: v("--color-inset", "#f8f9fc"),
    fg: v("--color-fg", "#18202a"),
    selection: v("--color-accent-tint", "#eef0ff"),
    fontMono: v("--font-mono", "Menlo, monospace"),
  };
}

/** 활성 터미널에서 첨부할 텍스트: 선택 영역이 있으면 그것, 없으면 버퍼 끝의 최근 40줄(빈 줄 제외). */
function terminalAttachment(term: Terminal, title: string): string {
  const sel = term.getSelection();
  if (sel.trim()) return formatTerminalAttachment({ title, text: sel, selection: true });
  const buf = term.buffer.active;
  const lines: string[] = [];
  for (let i = buf.length - 1; i >= 0 && lines.length < 40; i--) {
    const l = buf.getLine(i)?.translateToString(true) ?? "";
    if (lines.length === 0 && !l.trim()) continue; // 끝의 빈 줄은 건너뛴다
    lines.unshift(l);
  }
  return formatTerminalAttachment({ title, text: lines.join("\n"), selection: false });
}
