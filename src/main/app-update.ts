// 앱 업데이트 확인과 Homebrew 업그레이드.
//
// 서명·공증이 없어 electron-updater 로는 갱신할 수 없다. 대신 GitHub 최신 릴리즈와 버전을 비교하고,
// cask 로 설치된 앱이면 brew 로 갈아 끼운 뒤 다시 시작한다. brew upgrade 는 처음 "그래도 열기" 한
// 허용을 이어받으므로 업그레이드 뒤에도 Gatekeeper 경고가 다시 뜨지 않는다.

import { execFileSync, spawn } from "node:child_process";

export const RELEASE_REPO = "97kim/Atelier";
/** 탭까지 붙인 전체 이름. 같은 이름의 다른 cask 가 생겨도 이 탭의 것을 올린다. */
export const CASK = "97kim/atelier/atelier";
/** brew list 는 탭을 붙인 이름을 받지 않는다(exit 1). 설치 확인은 짧은 이름으로. */
const CASK_NAME = "atelier";
const UPGRADE_TIMEOUT_MS = 10 * 60 * 1000;
const TAIL_MAX = 2000;

/** "v0.9.29" · "0.9.29" 를 숫자 배열로. 숫자가 아닌 꼬리(-beta 등)는 버린다. */
function parts(v: string): number[] {
  return v
    .trim()
    .replace(/^v/i, "")
    .split(/[.-]/)
    .map((s) => Number.parseInt(s, 10))
    .filter((n) => Number.isFinite(n));
}

/** a 가 b 보다 새로우면 양수, 같으면 0, 오래되면 음수. */
export function compareVersions(a: string, b: string): number {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

export async function fetchLatestRelease(fetchImpl: typeof fetch = fetch): Promise<{ version: string; url: string }> {
  const res = await fetchImpl(`https://api.github.com/repos/${RELEASE_REPO}/releases/latest`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "atelier" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`GitHub 응답 ${res.status}`);
  const body = (await res.json()) as { tag_name?: unknown; html_url?: unknown };
  if (typeof body.tag_name !== "string" || parts(body.tag_name).length === 0) throw new Error("릴리즈 버전을 읽지 못했습니다.");
  return {
    version: body.tag_name.replace(/^v/i, ""),
    url: typeof body.html_url === "string" ? body.html_url : `https://github.com/${RELEASE_REPO}/releases/latest`,
  };
}

function tail(s: string): string {
  return s.length <= TAIL_MAX ? s : `…${s.slice(-TAIL_MAX)}`;
}

/** pid 와 그 모든 자손. brew 는 하위 명령(cp·git·curl)마다 새 프로세스 그룹을 만들어서 그룹 신호로는 닿지 않는다. */
function processTree(pid: number): number[] {
  let table: string;
  try {
    table = execFileSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  } catch {
    return [pid];
  }
  const children = new Map<number, number[]>();
  for (const line of table.split("\n")) {
    const [c, p] = line.trim().split(/\s+/).map(Number);
    if (!c || !p) continue;
    children.set(p, [...(children.get(p) ?? []), c]);
  }
  const all = [pid];
  for (let i = 0; i < all.length; i++) all.push(...(children.get(all[i]) ?? []));
  return all;
}

function killAll(pids: number[], signal: NodeJS.Signals): void {
  // 자손부터 — 부모가 먼저 죽으면 자손이 launchd 로 넘어가도 이미 목록에 있어 같이 끝난다
  for (const pid of [...pids].reverse()) {
    try {
      process.kill(pid, signal);
    } catch {
      /* 이미 끝남 */
    }
  }
}

/**
 * brew 를 실행한다. 비밀번호 같은 입력을 기다리며 멈추지 않게 stdin 은 닫는다.
 * 시간 초과면 자손까지 끝내고, 프로세스가 실제로 끝난(close) 뒤에 돌려준다 — 그 전에 돌려주면 호출 쪽 잠금이 풀려
 * 아직 도는 brew 와 새 brew 가 겹친다.
 */
export function runBrew(args: string[], env: NodeJS.ProcessEnv, timeoutMs = UPGRADE_TIMEOUT_MS, killGraceMs = 5000): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let timedOut = false;
    let closed: (() => void) | null = null;
    const child = spawn("brew", args, { env, stdio: ["ignore", "pipe", "pipe"] });
    // 시간 초과면 close 를 기다리지 않고 정리를 시작한다 — TERM 을 무시한 brew 나, 출력 파이프를 문 자손이 있으면
    // close 는 오지 않는다. 다 끝낸 뒤(파이프도 닫혔을 것) close 를 잠깐만 기다리고 돌려준다.
    const timer = setTimeout(() => {
      if (!child.pid) return;
      timedOut = true;
      const tracked = processTree(child.pid);
      killAll(tracked, "SIGTERM");
      const closing = new Promise<void>((r) => (closed = r));
      void waitGone(tracked, killGraceMs)
        .then(() => Promise.race([closing, new Promise((r) => setTimeout(r, 1000))]))
        .then(() => resolve({ code: null, out: tail(`${out}\n시간 초과`) }));
    }, timeoutMs);
    child.stdout.on("data", (d) => (out = tail(out + d)));
    child.stderr.on("data", (d) => (out = tail(out + d)));
    // 실행 자체가 실패하면(brew 없음) close 가 오지 않을 수 있다
    child.on("error", (e) => {
      if (child.pid) return;
      clearTimeout(timer);
      resolve({ code: null, out: tail(`${out}\n${e.message}`) });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (timedOut) closed?.();
      else resolve({ code, out });
    });
  });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** TERM 을 보낸 프로세스들이 끝나기를 기다린다. 유예가 지나면 KILL 하고, 그래도 남으면(좀비 등) 더 기다리지 않는다. */
async function waitGone(pids: number[], graceMs: number): Promise<void> {
  const started = Date.now();
  let killed = false;
  while (pids.some(alive)) {
    const waited = Date.now() - started;
    if (!killed && waited >= graceMs) {
      killAll(pids, "SIGKILL");
      killed = true;
    }
    if (waited >= graceMs * 3) return;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/** cask 로 설치된 버전. brew 가 없거나 cask 로 설치하지 않았으면 null. */
export async function caskVersion(env: NodeJS.ProcessEnv): Promise<string | null> {
  const r = await runBrew(["list", "--cask", "--versions", CASK_NAME], env, 30_000);
  if (r.code !== 0) return null;
  // "atelier 0.9.29"
  return r.out.trim().split(/\s+/)[1] ?? null;
}

/**
 * 탭을 새로 받아 cask 를 target 버전으로 올린다. 사용자가 HOMEBREW_NO_AUTO_UPDATE 를 켜 뒀거나 최근에 갱신해
 * 자동 갱신을 건너뛰면 탭이 옛 버전을 가리키므로, brew update 를 먼저 명시적으로 돌린다.
 * cask 가 이미 최신이면 brew upgrade 는 경고만 내고 0 으로 끝난다 — 릴리즈는 올라왔는데 탭 갱신 전인
 * 구간이 있으므로, 끝난 뒤 설치 버전이 target 에 닿았는지 확인한다.
 */
export async function brewUpgrade(env: NodeJS.ProcessEnv, target: string): Promise<{ ok: true; version: string } | { ok: false; error: string }> {
  const update = await runBrew(["update", "--quiet"], env);
  if (update.code !== 0) return { ok: false, error: `brew update 실패\n${update.out.trim()}` };
  const upgrade = await runBrew(["upgrade", "--cask", CASK], { ...env, HOMEBREW_NO_AUTO_UPDATE: "1" });
  if (upgrade.code !== 0) return { ok: false, error: `brew upgrade 실패\n${upgrade.out.trim()}` };
  const version = await caskVersion(env);
  if (!version || compareVersions(version, target) < 0)
    return { ok: false, error: `Homebrew에 아직 ${target} 버전이 올라오지 않았습니다(설치된 버전 ${version ?? "알 수 없음"}). 잠시 뒤 다시 시도하세요.` };
  return { ok: true, version };
}
