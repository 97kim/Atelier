// 에이전트가 앱 안 브라우저를 조작하는 명령(atelier browser read/click/fill)의 주입 스크립트.
// main 이 webContents.executeJavaScript 로 이걸 실행하고 결과를 JSON 으로 받는다.
//
// 스크립트는 문자열로 페이지에 들어가므로 값은 반드시 JSON.stringify 로 싣는다 — 따옴표·역슬래시·
// 줄바꿈이 든 선택자나 입력값이 코드를 깨뜨리지 않게. 결과는 항상 { ok } 또는 { error } 한 덩어리다.

/** read 가 돌려줄 페이지 요약. 모델이 화면을 볼 수 없으므로 글과 눌 만한 것을 같이 준다. */
export interface PageRead {
  url: string;
  title: string;
  /** 보이는 본문 텍스트(잘림). */
  text: string;
  /** 잘렸나 — 모델이 더 볼 게 있는지 알 수 있게. */
  truncated: boolean;
  /** 누를 만한 것들: 버튼·링크·입력. 선택자와 함께 준다. */
  controls: { kind: "button" | "link" | "input"; label: string; selector: string }[];
}

export const READ_TEXT_MAX = 20000;
export const READ_CONTROLS_MAX = 60;

/** 페이지 안에서 쓸 공용 조각 — 요소의 짧은 CSS 선택자를 만든다. */
const SELECTOR_FN = `
function sel(el) {
  if (el.id && /^[A-Za-z][\\w-]*$/.test(el.id)) return "#" + el.id;
  const tn = el.tagName.toLowerCase();
  const name = el.getAttribute("name");
  if (name) return tn + '[name="' + name + '"]';
  const test = el.getAttribute("data-testid") || el.getAttribute("data-test");
  if (test) return tn + '[data-testid="' + test + '"]';
  const parent = el.parentElement;
  if (!parent) return tn;
  const same = [...parent.children].filter((c) => c.tagName === el.tagName);
  const idx = same.indexOf(el) + 1;
  const base = same.length > 1 ? tn + ":nth-of-type(" + idx + ")" : tn;
  const pid = parent.id && /^[A-Za-z][\\w-]*$/.test(parent.id) ? "#" + parent.id : null;
  return (pid ? pid + " > " : "") + base;
}
function visible(el) {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== "hidden" && st.display !== "none" && st.opacity !== "0";
}
function label(el) {
  const t = (el.innerText || el.value || el.getAttribute("aria-label") || el.getAttribute("placeholder") || el.getAttribute("title") || "").trim();
  return t.replace(/\\s+/g, " ").slice(0, 80);
}`;

/** 페이지를 읽는다. */
export function readScript(): string {
  return `(() => {${SELECTOR_FN}
  const raw = (document.body ? document.body.innerText : "") || "";
  const text = raw.replace(/\\n{3,}/g, "\\n\\n").trim();
  const out = [];
  const seen = new Set();
  const push = (kind, el) => {
    if (out.length >= ${READ_CONTROLS_MAX} || !visible(el)) return;
    const s = sel(el);
    const key = kind + "|" + s;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ kind, label: label(el), selector: s });
  };
  for (const el of document.querySelectorAll('button, [role="button"], input[type="submit"], input[type="button"]')) push("button", el);
  for (const el of document.querySelectorAll("a[href]")) push("link", el);
  for (const el of document.querySelectorAll("input, textarea, select")) {
    const t = (el.getAttribute("type") || "").toLowerCase();
    if (t === "submit" || t === "button" || t === "hidden") continue;
    push("input", el);
  }
  return {
    ok: true,
    url: location.href,
    title: document.title || "",
    text: text.slice(0, ${READ_TEXT_MAX}),
    truncated: text.length > ${READ_TEXT_MAX},
    controls: out,
  };
})()`;
}

/**
 * 클릭. 선택자로 찾거나(selector), 보이는 글로 찾는다(text).
 * 글로 찾을 때는 보이는 것 중 글이 가장 짧은 것을 고른다 — 바깥 컨테이너가 아니라 실제 버튼이 잡히게.
 */
export function clickScript(target: { selector?: string; text?: string }): string {
  const bySel = JSON.stringify(target.selector ?? "");
  const byText = JSON.stringify(target.text ?? "");
  return `(() => {${SELECTOR_FN}
  const wantSel = ${bySel}, wantText = ${byText};
  let el = null;
  if (wantSel) {
    el = document.querySelector(wantSel);
    if (!el) return { error: "선택자에 맞는 요소가 없습니다: " + wantSel };
  } else if (wantText) {
    const needle = wantText.toLowerCase();
    const cands = [...document.querySelectorAll('button, a[href], [role="button"], input[type="submit"], input[type="button"], label')]
      .filter((e) => visible(e) && label(e).toLowerCase().includes(needle));
    if (cands.length === 0) return { error: "그 글이 든 누를 만한 것이 없습니다: " + wantText };
    cands.sort((a, b) => label(a).length - label(b).length);
    el = cands[0];
  } else {
    return { error: "--selector 나 --text 중 하나가 필요합니다." };
  }
  if (!visible(el)) return { error: "요소가 화면에 보이지 않습니다: " + sel(el) };
  el.scrollIntoView({ block: "center" });
  el.click();
  return { ok: true, clicked: { selector: sel(el), label: label(el), tag: el.tagName.toLowerCase() } };
})()`;
}

/** 입력값 채우기. React 처럼 값 변경을 가로채는 프레임워크도 알아채도록 네이티브 setter 로 넣고 이벤트를 쏜다. */
export function fillScript(selector: string, value: string): string {
  return `(() => {${SELECTOR_FN}
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return { error: "선택자에 맞는 요소가 없습니다: " + ${JSON.stringify(selector)} };
  const tag = el.tagName.toLowerCase();
  if (tag !== "input" && tag !== "textarea" && tag !== "select" && el.isContentEditable !== true)
    return { error: "값을 넣을 수 있는 요소가 아닙니다: " + tag };
  const v = ${JSON.stringify(value)};
  el.focus();
  if (el.isContentEditable) {
    el.textContent = v;
  } else {
    // React 는 value 를 가로채므로 프로토타입의 setter 를 직접 부른다 — 안 그러면 화면만 바뀌고 상태는 그대로다.
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : tag === "select" ? window.HTMLSelectElement.prototype : window.HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(proto, "value");
    if (setter && setter.set) setter.set.call(el, v);
    else el.value = v;
  }
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, filled: { selector: sel(el), tag, value: v.slice(0, 200) } };
})()`;
}
