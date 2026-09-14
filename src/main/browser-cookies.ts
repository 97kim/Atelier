// 앱 안 브라우저의 "로그인 유지". 파티션이 persist: 라 만료가 있는 쿠키는 디스크에 남지만,
// 로그인 세션은 대개 만료 없는 세션 쿠키라 Chromium 이 종료할 때 버린다(메모리에만 둔다).
// 크롬의 "이전 세션 계속하기" 와 같은 일을 한다 — 끌 때 받아 적고 켤 때 되돌려 놓는다.
//
// 이건 사실상 로그인 증표를 디스크에 두는 일이다. 그래서 설정으로 끌 수 있고, 끄면 적어 둔 것을 지운다.
// 값은 safeStorage(macOS 는 키체인)로 암호화해 둔다 — Chromium 이 자기 쿠키 DB 에 하는 것과 같은 방식이다.
// 파일 권한(600)만으로는 백업·동기화에 평문이 그대로 실려 나간다.

import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { Cookie, CookiesSetDetails, Session } from "electron";

/** 적어 둘 쿠키의 최소 정보. Electron 의 Cookie 를 그대로 쓰지 않는 이유는 되돌릴 때 필요한 것만 남기려고. */
export interface SavedCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  secure: boolean;
  httpOnly: boolean;
  sameSite?: "unspecified" | "no_restriction" | "lax" | "strict";
  /** 도메인 쿠키(.example.com)인지 호스트 한정인지 — 되돌릴 때 domain 을 줄지 말지가 갈린다. */
  hostOnly: boolean;
}

/** 너무 많이 쌓이지 않게. 로그인 증표는 사이트당 몇 개다. */
export const SESSION_COOKIE_MAX = 500;

/** 쿠키를 다시 심을 때 쓸 주소. domain 앞의 점은 URL 에 넣을 수 없다. */
export function cookieUrl(c: Pick<SavedCookie, "domain" | "path" | "secure">): string {
  const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  return `${c.secure ? "https" : "http"}://${host}${c.path || "/"}`;
}

/** Electron 의 Cookie → 적어 둘 모양. 세션 쿠키가 아니면 null(그건 이미 디스크에 있다). */
export function toSaved(c: Cookie): SavedCookie | null {
  if (!c.session) return null;
  if (!c.domain || !c.name) return null;
  return {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || "/",
    secure: !!c.secure,
    httpOnly: !!c.httpOnly,
    sameSite: c.sameSite,
    hostOnly: !c.domain.startsWith("."),
  };
}

/**
 * 되돌릴 때 넘길 값. expirationDate 를 주지 않아야 다시 세션 쿠키가 된다 —
 * 만료를 붙이면 원래보다 오래 사는 쿠키로 성질이 바뀐다.
 */
export function toSetDetails(c: SavedCookie): CookiesSetDetails {
  return {
    url: cookieUrl(c),
    name: c.name,
    value: c.value,
    path: c.path,
    secure: c.secure,
    httpOnly: c.httpOnly,
    sameSite: c.sameSite,
    // 호스트 한정이면 domain 을 주지 않는다 — 주면 하위 도메인까지 퍼지는 쿠키가 된다.
    ...(c.hostOnly ? {} : { domain: c.domain }),
  };
}

/** 디스크의 값은 믿지 않는다 — 모양이 틀린 항목은 조용히 버린다. */
export function parseSaved(raw: string): SavedCookie[] {
  try {
    const v = JSON.parse(raw);
    if (!Array.isArray(v)) return [];
    return v
      .filter(
        (c): c is SavedCookie =>
          !!c && typeof c.name === "string" && typeof c.value === "string" && typeof c.domain === "string" && typeof c.path === "string",
      )
      .slice(0, SESSION_COOKIE_MAX);
  } catch {
    return [];
  }
}

export function cookieFilePath(userData: string): string {
  return path.join(userData, "browser-session-cookies.enc");
}

/** 암호화 전에 쓰던 평문 파일. 있으면 한 번 옮겨 담고 지운다. */
export function legacyCookieFilePath(userData: string): string {
  return path.join(userData, "browser-session-cookies.json");
}

/**
 * 종료 직전에 부른다. 실패해도 종료를 막지 않는다.
 * 암호화를 못 쓰는 환경이면 저장하지 않는다 — 편의를 잃는 편이 평문으로 남기는 것보다 낫다.
 */
export async function saveSessionCookies(ses: Session, userData: string): Promise<number> {
  const file = cookieFilePath(userData);
  try {
    const all = await ses.cookies.get({});
    const saved = all.map(toSaved).filter((c): c is SavedCookie => c !== null).slice(0, SESSION_COOKIE_MAX);
    if (saved.length === 0) {
      forgetSessionCookies(userData);
      return 0;
    }
    if (!safeStorage.isEncryptionAvailable()) {
      console.error("[browser] 암호화를 쓸 수 없어 세션 쿠키를 저장하지 않습니다(로그인이 유지되지 않습니다).");
      forgetSessionCookies(userData);
      return 0;
    }
    fs.writeFileSync(file, safeStorage.encryptString(JSON.stringify(saved)), { mode: 0o600 });
    fs.rmSync(legacyCookieFilePath(userData), { force: true }); // 평문이 남아 있으면 지운다
    return saved.length;
  } catch (e) {
    console.error("[browser] 세션 쿠키 저장 실패:", e);
    return 0;
  }
}

/** 암호문 또는 (예전) 평문에서 목록을 읽는다. 못 읽으면 빈 목록 — 로그인만 풀린다. */
function readSaved(userData: string): SavedCookie[] {
  const enc = cookieFilePath(userData);
  if (fs.existsSync(enc)) {
    try {
      return parseSaved(safeStorage.decryptString(fs.readFileSync(enc)));
    } catch (e) {
      // 키체인이 바뀌었거나 다른 기기에서 옮겨 온 파일 — 되살릴 수 없으니 버린다.
      console.error("[browser] 세션 쿠키를 풀지 못해 버립니다:", e);
      fs.rmSync(enc, { force: true });
      return [];
    }
  }
  const legacy = legacyCookieFilePath(userData);
  try {
    const list = parseSaved(fs.readFileSync(legacy, "utf8"));
    fs.rmSync(legacy, { force: true }); // 한 번 읽고 지운다 — 다음부터는 암호문만 남는다
    if (list.length > 0) console.log(`[browser] 평문 세션 쿠키 ${list.length}개를 옮겨 담습니다`);
    return list;
  } catch {
    return [];
  }
}

/** 창을 띄우기 전에 부른다. 하나씩 심고, 실패한 것은 건너뛴다(사이트 하나 때문에 전부 날리지 않게). */
export async function restoreSessionCookies(ses: Session, userData: string): Promise<number> {
  const list = readSaved(userData);
  if (list.length === 0) return 0;
  let ok = 0;
  for (const c of list) {
    try {
      await ses.cookies.set(toSetDetails(c));
      ok += 1;
    } catch {
      /* 그 사이트만 로그인이 풀린다 */
    }
  }
  return ok;
}

/** 설정을 끄거나 사용자가 지울 때. 평문으로 쓰던 시절의 파일도 같이 지운다. */
export function forgetSessionCookies(userData: string): void {
  for (const f of [cookieFilePath(userData), legacyCookieFilePath(userData)]) {
    try {
      fs.rmSync(f, { force: true });
    } catch {
      /* 없으면 그만 */
    }
  }
}
