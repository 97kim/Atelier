// 에디터 패널의 브라우저 탭. Electron <webview>(main 의 will-attach-webview 가 preload 없음·node 없음·http(s) 만으로 제한) 위에
// 주소창·뒤로/앞으로/새로고침·외부 브라우저 열기를 둔다. 탭 키(초기 URL 또는 browser:<n>)는 고정이고 이동은 이 안에서만 일어난다.
import { useEffect, useRef, useState } from "react";
import { Icon } from "./Icon";
import { normalizeUrl } from "../browser-url";
import { browserTabLabel } from "../editor-tabs";
import type { ChatImageDto } from "@shared/ipc";
import { PICKER_STOP_SCRIPT, dataUrlImage, elementImage, formatElementAttachment, parsePickMessage, pickerScript } from "@shared/element-pick";
import { DIAG_MAX_CONSOLE, formatDiagnostics, pushCapped, type ConsoleLine } from "@shared/browser-diagnostics";

export { normalizeUrl };

export function BrowserPane({
  initialUrl,
  visible,
  onLabel,
  onAttach,
  onUrlChange,
}: {
  initialUrl: string | null;
  visible: boolean;
  /** 탭 스트립에 보일 라벨(호스트 또는 페이지 제목)이 바뀔 때. */
  onLabel?: (label: string) => void;
  /** "요소 선택" 결과(HTML·스타일 텍스트 + 스크린샷 조각)를 입력창에 붙인다. */
  onAttach?: (block: string, images?: ChatImageDto[]) => void;
  /** 보고 있는 주소가 바뀔 때. 탭이 내려갔다 올라와도 같은 페이지로 돌아오게 밖에서 들고 있는다. */
  onUrlChange?: (url: string) => void;
}) {
  const view = useRef<AtelierWebview | null>(null);
  // <webview> 는 주소가 생긴 뒤에야 렌더되므로, 마운트 시점을 state 로 잡아 그때 리스너를 붙인다.
  const [mounted, setMounted] = useState(false);
  const onLabelRef = useRef(onLabel);
  onLabelRef.current = onLabel;
  const onUrlChangeRef = useRef(onUrlChange);
  onUrlChangeRef.current = onUrlChange;
  const [url, setUrl] = useState(initialUrl ?? "");
  const [input, setInput] = useState(initialUrl ?? "");
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(false);
  const [nav, setNav] = useState({ back: false, forward: false });
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // 요소 선택 모드: 페이지에 스크립트를 주입해 마우스를 올리면 테두리, 클릭하면 console-message 로 요소 정보가 온다
  const [picking, setPicking] = useState(false);
  const [pickMsg, setPickMsg] = useState<string | null>(null);
  const onAttachRef = useRef(onAttach);
  onAttachRef.current = onAttach;
  const pickingRef = useRef(false);
  pickingRef.current = picking;
  // 콘솔 줄은 화면에 안 그리므로 ref 에만 쌓는다(매 줄 렌더링하면 로그가 쏟아질 때 앱이 느려진다)
  const consoleRef = useRef<ConsoleLine[]>([]);
  const [diagBusy, setDiagBusy] = useState(false);
  // 선택 세션마다 새 표식 — 페이지가 표식을 미리 알 수 없어 위조가 어렵고, 옛 세션의 늦은 메시지도 걸러진다
  const nonceRef = useRef("");
  const startPick = async () => {
    const el = view.current;
    if (!el || !url) return;
    setPickMsg(null);
    try {
      nonceRef.current = Math.random().toString(36).slice(2) + Date.now().toString(36);
      await el.executeJavaScript(pickerScript(nonceRef.current));
      setPicking(true);
    } catch (e) {
      setPickMsg(`요소 선택을 시작하지 못했습니다: ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const stopPick = () => {
    setPicking(false);
    void view.current?.executeJavaScript(PICKER_STOP_SCRIPT).catch(() => {});
  };
  // 앱 쪽에 포커스가 있을 때의 esc 도 취소로(페이지 안 esc 는 주입 스크립트가 처리)
  useEffect(() => {
    if (!picking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      stopPick();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [picking]);
  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const onConsole = (e: Event) => {
      const d = e as Event & { message?: string; level?: number; line?: number; sourceId?: string };
      const msg = d.message ?? "";
      const r = parsePickMessage(msg, nonceRef.current);
      if (!r) {
        // 요소 선택 표식이 아닌 보통 로그 — 진단 첨부용으로 모아 둔다
        consoleRef.current = pushCapped(
          consoleRef.current,
          { ts: Date.now(), level: typeof d.level === "number" ? d.level : 1, text: msg, source: d.sourceId || undefined, line: d.line },
          DIAG_MAX_CONSOLE * 3,
        );
        return;
      }
      if (!pickingRef.current) return;
      setPicking(false);
      nonceRef.current = "";
      if (r.kind === "cancel") return;
      const picked = r.element;
      void (async () => {
        let images: ChatImageDto[] | undefined;
        // 요소 영역만 잘라 스크린샷(뷰포트 좌표 = capturePage 좌표). 화면 밖·0 크기는 건너뛴다
        const rect = { x: Math.max(0, Math.floor(picked.rect.x)), y: Math.max(0, Math.floor(picked.rect.y)), width: Math.ceil(picked.rect.width), height: Math.ceil(picked.rect.height) };
        if (rect.width >= 2 && rect.height >= 2) {
          try {
            const img = await el.capturePage(rect);
            const one = img.isEmpty() ? null : elementImage(img.toDataURL(), picked);
            if (one) images = [one];
          } catch {
            /* 캡처 실패는 텍스트만 */
          }
        }
        let pageUrl = url;
        try {
          pageUrl = el.getURL() || url;
        } catch {
          /* 무시 */
        }
        onAttachRef.current?.(formatElementAttachment(picked, pageUrl), images);
        setPickMsg(`${picked.selector} 를 입력창에 붙였습니다${images ? " (스크린샷 포함)" : ""}`);
        setTimeout(() => setPickMsg(null), 4000);
      })();
    };
    el.addEventListener("console-message", onConsole);
    // 페이지가 바뀌면 주입한 스크립트도 사라진다 — 모드를 끄고, 콘솔도 새 페이지 기준으로 비운다
    const onNav = () => {
      setPicking(false);
      consoleRef.current = [];
    };
    el.addEventListener("did-navigate", onNav);
    return () => {
      el.removeEventListener("console-message", onConsole);
      el.removeEventListener("did-navigate", onNav);
    };
  }, [mounted, url]);

  useEffect(() => {
    const el = view.current;
    if (!el) return;
    const sync = () => {
      try {
        const u = el.getURL();
        setUrl(u);
        setInput(u);
        onUrlChangeRef.current?.(u);
        setNav({ back: el.canGoBack(), forward: el.canGoForward() });
        try {
          onLabelRef.current?.(browserTabLabel(u));
        } catch {
          /* 무시 */
        }
      } catch {
        /* 아직 붙기 전 */
      }
    };
    const onTitle = (e: Event) => {
      const t = (e as CustomEvent & { title?: string }).title ?? el.getTitle();
      setTitle(t);
      if (t) onLabelRef.current?.(t.length > 28 ? `${t.slice(0, 28)}…` : t);
    };
    const onStart = () => {
      setLoading(true);
      setError(null);
    };
    const onStop = () => {
      setLoading(false);
      sync();
    };
    const onFail = (e: Event) => {
      const d = e as Event & { errorDescription?: string; validatedURL?: string; isMainFrame?: boolean };
      if (d.isMainFrame === false) return;
      setLoading(false);
      if (d.errorDescription && d.errorDescription !== "ERR_ABORTED") setError(`${d.errorDescription} — ${d.validatedURL ?? ""}`);
    };
    el.addEventListener("did-navigate", sync);
    el.addEventListener("did-navigate-in-page", sync);
    el.addEventListener("page-title-updated", onTitle);
    el.addEventListener("did-start-loading", onStart);
    el.addEventListener("did-stop-loading", onStop);
    el.addEventListener("did-fail-load", onFail);
    return () => {
      el.removeEventListener("did-navigate", sync);
      el.removeEventListener("did-navigate-in-page", sync);
      el.removeEventListener("page-title-updated", onTitle);
      el.removeEventListener("did-start-loading", onStart);
      el.removeEventListener("did-stop-loading", onStop);
      el.removeEventListener("did-fail-load", onFail);
    };
  }, [mounted]);

  // 빈 탭은 주소창부터
  useEffect(() => {
    if (!initialUrl && visible) inputRef.current?.focus();
  }, [initialUrl, visible]);

  // 에디터가 "브라우저에서 보기" 를 다시 누르거나 HTML 을 저장하면 그 URL 을 보고 있는 탭을 다시 불러온다
  useEffect(() => {
    const onReload = (e: Event) => {
      const target = (e as CustomEvent<string>).detail;
      const el = view.current;
      if (!el || !target) return;
      try {
        if (el.getURL().split("#")[0] === target.split("#")[0]) el.reload();
      } catch {
        /* 아직 붙기 전 */
      }
    };
    window.addEventListener("atelier:browser-reload", onReload);
    return () => window.removeEventListener("atelier:browser-reload", onReload);
  }, [mounted]);

  /** 지금 보이는 화면 + 콘솔 경고·오류 + 실패한 요청을 한 덩어리로 입력창에 붙인다. */
  const attachDiagnostics = async () => {
    const el = view.current;
    if (!el || !url || diagBusy) return;
    setDiagBusy(true);
    try {
      let images: ChatImageDto[] | undefined;
      try {
        const img = await el.capturePage(); // 영역을 생략하면 지금 보이는 화면
        const one = img.isEmpty() ? null : dataUrlImage(img.toDataURL(), "browser.png");
        if (one) images = [one];
      } catch {
        /* 캡처 실패는 텍스트만 */
      }
      let net: Awaited<ReturnType<typeof window.workbench.browser.netFailures>> = [];
      try {
        net = await window.workbench.browser.netFailures(el.getWebContentsId(), true);
      } catch {
        /* 수집이 없으면 빈 목록 */
      }
      const rect = el.getBoundingClientRect();
      onAttachRef.current?.(
        formatDiagnostics({
          url: (() => {
            try {
              return el.getURL() || url;
            } catch {
              return url;
            }
          })(),
          title,
          at: Date.now(),
          viewport: { width: Math.round(rect.width), height: Math.round(rect.height) },
          console: consoleRef.current,
          net,
          hasScreenshot: Boolean(images),
        }),
        images,
      );
      const errs = consoleRef.current.filter((c) => c.level >= 2).length;
      setPickMsg(`진단을 입력창에 붙였습니다 (콘솔 ${errs}건 · 요청 실패 ${net.length}건${images ? " · 화면 캡처" : ""})`);
      setTimeout(() => setPickMsg(null), 4000);
    } finally {
      setDiagBusy(false);
    }
  };

  const go = (raw: string) => {
    const next = normalizeUrl(raw);
    if (!next) return;
    setError(null);
    setUrl(next);
    setInput(next);
    onUrlChange?.(next);
    const el = view.current;
    if (el && url) void el.loadURL(next).catch(() => {});
    // url 이 비어 있으면(빈 탭) src 로 처음 붙는다
  };

  return (
    <div className="flex h-full min-h-0 flex-col" data-browser-pane={url || "blank"}>
      <div className="flex items-center gap-1 border-b border-line px-2 py-1">
        <button onClick={() => view.current?.goBack()} disabled={!nav.back} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30" title="뒤로" data-browser-back>
          <Icon name="chevronRight" size={13} className="rotate-180" />
        </button>
        <button onClick={() => view.current?.goForward()} disabled={!nav.forward} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30" title="앞으로">
          <Icon name="chevronRight" size={13} />
        </button>
        <button onClick={() => (loading ? view.current?.stop() : view.current?.reload())} disabled={!url} className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30" title={loading ? "중지" : "새로고침"} data-browser-reload>
          <Icon name={loading ? "x" : "refresh"} size={13} className={loading ? "" : ""} />
        </button>
        <form
          className="min-w-0 flex-1"
          onSubmit={(e) => {
            e.preventDefault();
            go(input);
          }}
        >
          <input
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onFocus={(e) => e.target.select()}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setInput(url);
            }}
            placeholder="주소를 입력하세요 (localhost:3000, example.com …)"
            spellCheck={false}
            className="mono w-full rounded-md border border-line bg-inset px-2.5 py-1 text-[11.5px] text-fg outline-none placeholder:text-muted focus:border-accent/50"
            style={{ userSelect: "text" }}
            data-browser-url
          />
        </form>
        <button
          onClick={() => (picking ? stopPick() : void startPick())}
          disabled={!url || loading}
          className={`flex items-center gap-1 rounded-md border px-2 py-0.5 text-[11px] disabled:opacity-30 ${picking ? "border-accent/40 bg-accent-tint text-accent" : "border-line text-muted hover:bg-panel-2 hover:text-fg"}`}
          title={picking ? "요소 선택 취소 (페이지에서 esc)" : "페이지의 요소를 클릭해 HTML·스타일·스크린샷을 입력창에 붙입니다"}
          data-browser-pick={picking ? "on" : "off"}
        >
          <Icon name="edit" size={11} />
          {picking ? "요소를 클릭하세요…" : "요소 선택"}
        </button>
        <button
          onClick={() => void attachDiagnostics()}
          disabled={!url || diagBusy}
          className="flex items-center gap-1 rounded-md border border-line px-2 py-0.5 text-[11px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
          title="지금 화면·콘솔 경고와 오류·실패한 요청을 한 번에 입력창에 붙입니다"
          data-browser-diagnose
        >
          <Icon name="alert" size={11} />
          {diagBusy ? "모으는 중…" : "진단 첨부"}
        </button>
        <button
          onClick={() => {
            const el = view.current;
            if (!el) return;
            try {
              if (el.isDevToolsOpened()) el.closeDevTools();
              else el.openDevTools();
            } catch {
              /* 아직 붙기 전 */
            }
          }}
          disabled={!url}
          className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
          title="개발자 도구 (콘솔·네트워크·요소)"
          data-browser-devtools
        >
          <Icon name="terminal" size={13} />
        </button>
        <button
          onClick={() => url && void window.workbench.browser.openExternal(url)}
          disabled={!url}
          className="rounded p-1 text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-30"
          title="기본 브라우저에서 열기"
          data-browser-external
        >
          <Icon name="globe" size={13} />
        </button>
      </div>
      {error && (
        <div className="border-b border-err/40 bg-err-bg px-3 py-1 text-[11px] text-err" data-browser-error>
          {error}
        </div>
      )}
      {pickMsg && (
        <div className="border-b border-line bg-accent-tint px-3 py-1 text-[11px] text-accent" data-browser-pick-msg>
          {pickMsg}
        </div>
      )}
      <div className="relative min-h-0 flex-1 bg-white">
        {url ? (
          // partition 을 앱 세션과 분리해 쿠키·저장소가 섞이지 않게 한다.
          <webview
            ref={(el) => {
              view.current = el as unknown as AtelierWebview | null; // React 의 HTMLWebViewElement 타입엔 Electron 메서드가 없다
              setMounted(!!el);
            }}
            src={url}
            partition="persist:atelier-browser"
            style={{ width: "100%", height: "100%" }}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-2 bg-inset text-muted">
            <Icon name="globe" size={22} className="opacity-50" />
            <span>위 주소창에 주소를 입력하면 여기에 열립니다.</span>
            <span className="mono text-[10.5px] text-muted-2">개발 서버 미리보기 · 문서 · 채팅의 링크</span>
          </div>
        )}
      </div>
      <div className="mono flex items-center gap-2 border-t border-line px-2 py-0.5 text-[10px] text-muted">
        <span className="truncate">{title || (loading ? "불러오는 중…" : "")}</span>
      </div>
    </div>
  );
}
