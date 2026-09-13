import { memo, useEffect, useRef, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import type { Element, ElementContent, Root, Text } from "hast";
import { findFileRefs, localFileHref, parseFileRef, type FileRef as FileRefInfo } from "@shared/file-refs";
import { useLocateFile, useOpenFile } from "./FileViewer";
import { Icon } from "./Icon";

// ===== 답변 속 파일 참조("ProductByPoController.kt:63") → 에디터로 열기 =====
// rehype 단계에서 모양이 파일 참조인 텍스트·인라인 코드에 data-file-* 를 달아 두고, FileRef 가 렌더될 때 main 의 file:locate 로
// 실제로 있는 파일인지 확인해 있는 것만 링크로 바꾼다("Node.js" 같은 오탐은 그대로 글자로 남는다).

function markProps(ref: FileRefInfo): Record<string, string> {
  const p: Record<string, string> = { dataFilePath: ref.path };
  if (ref.line) p.dataFileLine = String(ref.line);
  if (ref.endLine) p.dataFileEnd = String(ref.endLine);
  return p;
}

/** hast 를 걸으며 파일 참조를 표시한다. pre·a 아래는 건드리지 않는다(코드 블록은 그대로, 링크는 이미 링크). */
function rehypeFileRefs() {
  const visit = (node: Root | Element, inCode: boolean) => {
    const kids = node.children as ElementContent[];
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (c.type === "element") {
        if (c.tagName === "pre" || c.tagName === "a") continue;
        if (c.tagName === "code") {
          // 인라인 코드 전체가 참조 하나면 code 자체를 링크로
          const text = c.children.map((k) => (k.type === "text" ? k.value : "")).join("");
          const ref = c.children.every((k) => k.type === "text") ? parseFileRef(text) : null;
          if (ref) c.properties = { ...c.properties, ...markProps(ref) };
          else visit(c, true);
          continue;
        }
        visit(c, inCode);
      } else if (c.type === "text" && !inCode) {
        const refs = findFileRefs(c.value);
        if (refs.length === 0) continue;
        const out: ElementContent[] = [];
        let pos = 0;
        for (const r of refs) {
          if (r.start > pos) out.push({ type: "text", value: c.value.slice(pos, r.start) } as Text);
          out.push({
            type: "element",
            tagName: "span",
            properties: markProps(r),
            children: [{ type: "text", value: r.text } as Text],
          } as Element);
          pos = r.end;
        }
        if (pos < c.value.length) out.push({ type: "text", value: c.value.slice(pos) } as Text);
        kids.splice(i, 1, ...out);
        i += out.length - 1;
      }
    }
  };
  return (tree: Root) => visit(tree, false);
}

/** 존재 확인 결과 캐시(cwd + 참조 → 경로들). 스트리밍 중 마크다운이 계속 다시 렌더돼도 다시 묻지 않는다. */
const located = new Map<string, string[] | Promise<string[]>>();
const LOCATED_MAX = 2000;

interface FileRefProps {
  path: string;
  line?: number;
  endLine?: number;
  /** span(본문 글자), code(인라인 코드), a(마크다운 링크 — 못 찾으면 링크 모양을 벗기고 이유를 title 로) */
  as: "span" | "code" | "a";
  className?: string;
  children?: ReactNode;
}

function FileRef({ path, line, endLine, as, className, children }: FileRefProps) {
  const { cwd, locate } = useLocateFile();
  const openFile = useOpenFile();
  const key = `${cwd ?? ""}\0${path}`;
  const [found, setFound] = useState<string[] | null>(() => {
    const v = located.get(key);
    return Array.isArray(v) ? v : null;
  });
  const [chooser, setChooser] = useState<{ x: number; y: number } | null>(null);

  useEffect(() => {
    if (!cwd) return;
    let alive = true;
    let v = located.get(key);
    if (!v) {
      if (located.size >= LOCATED_MAX) located.clear();
      v = locate(path).then(
        (r) => {
          located.set(key, r);
          return r;
        },
        () => {
          located.set(key, []);
          return [] as string[];
        },
      );
      located.set(key, v);
    }
    Promise.resolve(v).then((r) => alive && setFound(r));
    return () => {
      alive = false;
    };
  }, [cwd, key, locate, path]);

  useEffect(() => {
    if (!chooser) return;
    const close = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      setChooser(null);
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [chooser]);

  const Tag = as;
  if (!found || found.length === 0) {
    // 링크로 쓰였는데 파일이 없으면 링크처럼 보이지 않게(눌러도 아무 일 없으니). 확인 중(found=null)일 때도 잠깐 이 모양.
    if (as === "a") return <span className={className} title={found ? `파일을 찾지 못했습니다: ${path}` : undefined}>{children}</span>;
    return <Tag className={className}>{children}</Tag>;
  }

  const at = line ? { line, endLine } : null;
  const open = (p: string) => {
    setChooser(null);
    openFile(p, at);
  };
  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (found.length === 1) return open(found[0]);
    setChooser({ x: e.clientX, y: e.clientY + 6 });
  };
  const where = line ? ` (${line}${endLine ? `–${endLine}` : ""}줄)` : "";
  const title = found.length === 1 ? `에디터로 열기${where}\n${found[0]}` : `에디터로 열기${where} · ${found.length}개 중 선택`;
  const style = chooser ? { left: Math.min(chooser.x, window.innerWidth - 420), top: Math.min(chooser.y, window.innerHeight - 40 * Math.min(found.length, 8) - 24) } : undefined;
  return (
    <>
      <Tag role="link" tabIndex={0} className={`file-ref ${className ?? ""}`} title={title} onClick={onClick} data-file-ref={path}>
        {children}
      </Tag>
      {chooser && (
        <span role="menu" className="fixed z-50 flex w-[400px] flex-col rounded-lg border border-line bg-panel p-1.5 shadow-xl" style={style} onMouseDown={(e) => e.stopPropagation()} data-file-ref-chooser>
          <span className="px-2 pb-1 pt-0.5 text-[10px] text-muted">같은 이름의 파일이 여러 개입니다</span>
          {found.slice(0, 8).map((p) => (
            <button key={p} role="menuitem" onClick={() => open(p)} className="mono truncate rounded-md px-2 py-1.5 text-left text-[11.5px] hover:bg-panel-2" title={p}>
              {cwd && p.startsWith(cwd + "/") ? p.slice(cwd.length + 1) : p}
            </button>
          ))}
        </span>
      )}
    </>
  );
}

type RefAttrs = { "data-file-path"?: string; "data-file-line"?: string; "data-file-end"?: string };
function refOf(props: RefAttrs): Omit<FileRefProps, "as"> | null {
  const path = props["data-file-path"];
  if (!path) return null;
  const line = props["data-file-line"] ? Number(props["data-file-line"]) : undefined;
  const endLine = props["data-file-end"] ? Number(props["data-file-end"]) : undefined;
  return { path, line, endLine };
}
function stripRef<T extends RefAttrs & { node?: unknown }>(props: T) {
  const { node: _n, "data-file-path": _p, "data-file-line": _l, "data-file-end": _e, ...rest } = props;
  return rest;
}

function MdSpan(props: React.HTMLAttributes<HTMLSpanElement> & RefAttrs & { node?: unknown }) {
  const ref = refOf(props);
  const rest = stripRef(props);
  if (!ref) return <span {...rest} />;
  return <FileRef {...ref} as="span" className={rest.className}>{rest.children}</FileRef>;
}

function MdCode(props: React.HTMLAttributes<HTMLElement> & RefAttrs & { node?: unknown }) {
  const ref = refOf(props);
  const rest = stripRef(props);
  if (!ref) return <code {...rest} />;
  return <FileRef {...ref} as="code" className={rest.className}>{rest.children}</FileRef>;
}

/** 링크 열기 방식. "ask" 면 클릭할 때마다 고른다. localStorage 에 기억. */
export type LinkOpenMode = "ask" | "app" | "external";
const LINK_MODE_KEY = "workbench.linkOpenMode";
export function getLinkOpenMode(): LinkOpenMode {
  try {
    const v = localStorage.getItem(LINK_MODE_KEY);
    return v === "app" || v === "external" ? v : "ask";
  } catch {
    return "ask";
  }
}
export function setLinkOpenMode(mode: LinkOpenMode): void {
  try {
    if (mode === "ask") localStorage.removeItem(LINK_MODE_KEY);
    else localStorage.setItem(LINK_MODE_KEY, mode);
  } catch {
    /* 저장 못 해도 동작엔 지장 없음 */
  }
}

/**
 * 링크: 클릭하면 "앱 안 브라우저 / 기본 브라우저" 선택 팝업(기억 가능). ⌘/Ctrl·가운데 클릭은 바로 기본 브라우저,
 * ⌥클릭은 바로 앱 안 브라우저, ⇧클릭은 기억을 무시하고 다시 묻는다. 메인 창이 이동하는 일은 없다(preventDefault + main 의 will-navigate).
 * http(s) 가 아닌 링크(mailto 등)는 외부로만 보낸다.
 */
function MdLink(props: React.AnchorHTMLAttributes<HTMLAnchorElement> & { node?: unknown }) {
  const { node: _node, ...anchorProps } = props;
  // 로컬 파일을 가리키는 링크("[AGENTS.md 열기](/Users/me/dev/AGENTS.md)", file://, ~/, ./ …)는 브라우저가 아니라 에디터로.
  const local = props.href ? localFileHref(props.href) : null;
  if (local)
    return (
      <FileRef as="a" path={local.path} line={local.line} endLine={local.endLine} className={props.className}>
        {props.children}
      </FileRef>
    );
  return <MdWebLink {...anchorProps} />;
}

function MdWebLink({ href, children, ...rest }: React.AnchorHTMLAttributes<HTMLAnchorElement>) {
  const openFile = useOpenFile();
  const [chooser, setChooser] = useState<{ x: number; y: number } | null>(null);
  const [remember, setRemember] = useState(false);
  const anchor = useRef<HTMLAnchorElement>(null);

  const openIn = (where: "app" | "external") => {
    if (!href) return;
    if (where === "app") openFile(href);
    else void window.workbench.browser.openExternal(href);
  };
  const decide = (where: "app" | "external") => {
    if (remember) setLinkOpenMode(where);
    setChooser(null);
    openIn(where);
  };
  const onClick = (e: MouseEvent<HTMLAnchorElement>) => {
    if (!href) return;
    e.preventDefault();
    e.stopPropagation();
    const web = /^https?:\/\//i.test(href);
    if (!web || e.metaKey || e.ctrlKey || e.button === 1) return openIn("external");
    if (e.altKey) return openIn("app");
    const mode = e.shiftKey ? "ask" : getLinkOpenMode();
    if (mode !== "ask") return openIn(mode);
    const r = anchor.current?.getBoundingClientRect();
    setRemember(false);
    setChooser({ x: e.clientX || r?.left || 0, y: (r?.bottom ?? e.clientY) + 4 });
  };

  useEffect(() => {
    if (!chooser) return;
    const close = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      setChooser(null);
    };
    // 팝업 안 클릭은 stopPropagation 으로 막히므로 window 의 mousedown 은 바깥 클릭이다
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [chooser]);

  // 화면 오른쪽·아래로 넘치지 않게 위치를 조금 당긴다
  const style = chooser
    ? { left: Math.min(chooser.x, window.innerWidth - 300), top: Math.min(chooser.y, window.innerHeight - 130) }
    : undefined;

  return (
    <>
      <a
        ref={anchor}
        href={href}
        onClick={onClick}
        onAuxClick={(e) => e.button === 1 && onClick(e)}
        title={href ? `${href}\n클릭: 어디서 열지 선택 · ⌘클릭: 기본 브라우저 · ⌥클릭: 인앱 브라우저` : undefined}
        {...rest}
      >
        {children}
      </a>
      {chooser && href && (
        <div
          role="menu"
          className="fixed z-50 w-[288px] rounded-lg border border-line bg-panel p-1.5 shadow-xl"
          style={style}
          onMouseDown={(e) => e.stopPropagation()}
          data-link-chooser
        >
          <div className="mono truncate px-2 pb-1 pt-0.5 text-[10px] text-muted" title={href}>
            {href}
          </div>
          <button role="menuitem" onClick={() => decide("app")} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2" data-link-open-app>
            <Icon name="globe" size={12} className="text-accent" />
            <span className="flex-1">인앱 브라우저에서 열기</span>
            <span className="mono text-[10px] text-muted">⌥클릭</span>
          </button>
          <button role="menuitem" onClick={() => decide("external")} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2" data-link-open-external>
            <Icon name="arrowUp" size={12} className="rotate-45 text-muted" />
            <span className="flex-1">기본 브라우저에서 열기</span>
            <span className="mono text-[10px] text-muted">⌘클릭</span>
          </button>
          <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-line px-2 pb-0.5 pt-1.5 text-[11px] text-muted">
            <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-link-remember />
            다음부터 묻지 않기 <span className="mono text-[10px] text-muted-2">(⇧클릭으로 다시 선택)</span>
          </label>
        </div>
      )}
    </>
  );
}

export const Markdown = memo(function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight, rehypeFileRefs]}
        components={{ a: MdLink, span: MdSpan, code: MdCode }}
        // 기본 정리는 file: 을 지운다. 로컬 파일 링크는 MdLink 가 에디터로만 보내고 이동은 하지 않으므로 그 스킴만 남긴다.
        urlTransform={(url) => (/^file:/i.test(url) ? url : defaultUrlTransform(url))}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
