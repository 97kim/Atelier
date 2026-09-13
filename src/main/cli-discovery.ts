// CLI 자동 탐지 모듈 — macOS / Linux / Windows
//
// 책임 분리:
//   PathSource         : 사용자 셸/플랫폼에서 PATH를 캡처 (진실의 소스)
//   Verifier           : 발견된 binary가 실제로 동작하는지 검증 (--version)
//   DiscoveryCache     : 결과 in-memory 캐시 + stale 가드
//   UserOverrideStore  : 사용자가 직접 지정한 경로 우선
//   CliDiscovery       : 위 협력자를 묶는 orchestrator
//
// 사용자 셸 PATH가 진실의 소스다. npm/bun/asdf/brew 어디에 깔든 사용자가 터미널에서
// `claude` 칠 수 있으면 우리도 잡는다. 하드코딩된 후보 디렉토리나 패키지 매니저
// prefix 질의는 셸 PATH가 이미 포함하므로 불필요.
//
// PATH 첫 매치만 보지 않고 전체를 walk해서 모든 매치를 후보로 모은 뒤 순서대로
// verify한다. cmux wrapper처럼 첫 매치가 트램폴린이라 실패해도 같은 PATH의 다음
// 매치(예: ~/.local/bin/claude)로 자동 fallback된다.
//
// OS strategy(Posix/Windows)는 위 협력자들을 다른 구현으로 조립하는 팩토리에서만 분기됨.
// POSIX 셸 종류(bash/zsh/fish)는 printenv를 통해 통일되므로 별도 분기 없음.

import { execFile } from "child_process";
import fs from "fs";
import path from "path";

// ===== Public Types =====

export type Provider = "claude" | "codex" | "antigravity";

export interface CliStatus {
  installed: boolean;
  path: string | null;
  // 자동 탐지(PATH/static/PM)로 잡혔으면 "auto", 사용자가 직접 지정한 경로면 "override".
  // 미설치 시에는 "auto" (사용자 override가 없으니 자동 탐지가 실패한 것).
  source?: "auto" | "override";
  error?: string;
}

export interface CliCandidate {
  path: string;
  verified: boolean;       // --version exit 0 + non-empty 응답
  versionOutput?: string;  // --version 첫 줄 (예: "2.1.121 (Claude Code)")
}

export interface OverrideSetResult {
  ok: boolean;
  // 실패 사유. UI가 권한/디스크풀/읽기전용 등 케이스별 안내문 분기 가능.
  reason?: "not_found" | "permission_denied" | "disk_full" | "readonly_fs" | "unknown";
  message?: string;
}

export interface CliDiscovery {
  find(provider: Provider): Promise<CliStatus>;
  buildEnv(): Promise<NodeJS.ProcessEnv>;
  invalidate(provider?: Provider): void;
  setOverride(provider: Provider, binPath: string | null): OverrideSetResult;
  // 사용자에게 보여줄 후보 리스트. PATH walk + 각각 verify 결과 포함.
  listCandidates(provider: Provider): Promise<CliCandidate[]>;
}

// ===== Internal Collaborator Interfaces =====

interface PathSource {
  capture(): Promise<string[]>;
  invalidate(): void;
}

interface Verifier {
  verify(binPath: string, env: NodeJS.ProcessEnv): Promise<boolean>;
}

interface DiscoveryCache {
  get(provider: Provider): CliStatus | null;
  set(provider: Provider, status: CliStatus): void;
  invalidate(provider?: Provider): void;
}

interface UserOverrideStore {
  get(provider: Provider): string | null;
  set(provider: Provider, binPath: string | null): OverrideSetResult;
}

// ===== Helpers =====

const PROVIDER_COMMANDS: Record<Provider, string> = {
  claude: "claude",
  codex: "codex",
  antigravity: "agy",
};

// ===== POSIX Path Sources =====

class PosixShellPathSource implements PathSource {
  private cached: string[] | null = null;
  private inflight: Promise<string[]> | null = null;
  constructor(
    private readonly command: string[],
    private readonly delimiter: string,
    private readonly timeoutMs = 8000,
  ) {}

  capture(): Promise<string[]> {
    if (this.cached) return Promise.resolve(this.cached);
    if (this.inflight) return this.inflight;
    const shell = process.env.SHELL || "/bin/zsh";
    this.inflight = new Promise((resolve) => {
      execFile(shell, this.command, { timeout: this.timeoutMs }, (err, stdout) => {
        const list = err || !stdout
          ? []
          : stdout.toString().trim().split(this.delimiter).filter(Boolean);
        this.cached = list;
        this.inflight = null;
        resolve(list);
      });
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
    this.inflight = null;
  }
}

// 모든 POSIX 셸(bash/zsh/fish)이 자식 프로세스에 PATH를 콜론 join으로
// export하므로, 외부 명령 printenv를 통해 받으면 셸 별 분기가 불필요하다.
// (fish는 내부적으로 $PATH가 list지만 export 시 콜론으로 join — fish 공식 문서)
function posixShellPathSource(): PathSource {
  return new PosixShellPathSource(["-ilc", "printenv PATH"], ":");
}

// ===== Windows Path Source =====

class WindowsPathSource implements PathSource {
  private cached: string[] | null = null;
  private inflight: Promise<string[]> | null = null;

  capture(): Promise<string[]> {
    if (this.cached) return Promise.resolve(this.cached);
    if (this.inflight) return this.inflight;
    // PowerShell로 User + Machine PATH(레지스트리 영구 값) 읽고,
    // 현재 process.env.PATH(런타임 PATH)와 합쳐 dedupe.
    // process.env.PATH는 Electron 부모가 launchd/explorer로부터 받은 값이라
    // 두 소스를 모두 봐야 사용자가 시스템 환경에서 추가한 경로까지 잡힘.
    const psCmd =
      "[Environment]::GetEnvironmentVariable('PATH','User') + ';' + " +
      "[Environment]::GetEnvironmentVariable('PATH','Machine')";
    this.inflight = new Promise((resolve) => {
      execFile(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", psCmd],
        { timeout: 8000 },
        (err, stdout) => {
          const fromPs = err || !stdout ? "" : stdout.toString().trim();
          const fromEnv = process.env.PATH || "";
          const combined = [fromPs, fromEnv]
            .join(";")
            .split(";")
            .map((s) => s.trim())
            .filter(Boolean);
          this.cached = Array.from(new Set(combined));
          this.inflight = null;
          resolve(this.cached);
        },
      );
    });
    return this.inflight;
  }

  invalidate(): void {
    this.cached = null;
    this.inflight = null;
  }
}

// ===== Verifier =====

class VersionFlagVerifier implements Verifier {
  constructor(private readonly timeoutMs = 1500) {}

  verify(binPath: string, env: NodeJS.ProcessEnv): Promise<boolean> {
    // 동명 가짜 스크립트가 PATH에 있을 수 있으니 --version 응답 유무만 가볍게 확인.
    // (provider별 출력 포맷 strict 매치는 false negative가 늘어 채택하지 않음)
    return new Promise((resolve) => {
      execFile(
        binPath,
        ["--version"],
        { timeout: this.timeoutMs, env },
        (err, stdout, stderr) => {
          const output = (stdout || stderr || "").toString().trim();
          resolve(!err && output.length > 0);
        },
      );
    });
  }
}

// Windows는 npm/bun이 .cmd/.exe로 binary를 깔기 때문에 확장자별 후보를 펼쳐야
// PATH walk에서 발견 가능하다. POSIX는 확장자 없는 이름 그대로.
function expandCandidateFilenames(command: string): string[] {
  if (process.platform === "win32") {
    return [".cmd", ".exe", ".bat", ".ps1", ""].map((ext) => command + ext);
  }
  return [command];
}

// ===== Cache =====

class InMemoryDiscoveryCache implements DiscoveryCache {
  private entries = new Map<Provider, CliStatus>();

  get(provider: Provider): CliStatus | null {
    const entry = this.entries.get(provider);
    if (!entry) return null;
    // 사용 직전 stale 체크: 캐시된 path가 그 사이에 사라졌으면 무효화
    if (entry.installed && entry.path && !fs.existsSync(entry.path)) {
      this.entries.delete(provider);
      return null;
    }
    return entry;
  }

  set(provider: Provider, status: CliStatus): void {
    this.entries.set(provider, status);
  }

  invalidate(provider?: Provider): void {
    if (provider) this.entries.delete(provider);
    else this.entries.clear();
  }
}

// ===== User Override =====

class NoopUserOverrideStore implements UserOverrideStore {
  get(): string | null {
    return null;
  }
  set(): OverrideSetResult {
    // 휘발성 환경. 저장 안 하지만 의도된 동작이라 ok로 본다.
    return { ok: true };
  }
}

class FileBasedUserOverrideStore implements UserOverrideStore {
  // userData 디렉토리에 JSON으로 저장한다. localStorage는 렌더러 origin에 종속이라
  // CLI 경로처럼 main 권한이 필요한 데이터를 저장하기엔 부적절(렌더러 조작 위험).
  private cache: Record<string, string> | null = null;

  constructor(private readonly filePath: string) {}

  get(provider: Provider): string | null {
    return this.load()[provider] || null;
  }

  set(provider: Provider, binPath: string | null): OverrideSetResult {
    // 매 write 전에 디스크에서 fresh read — 외부에서 파일을 수정한 경우 메모리
    // 캐시가 stale일 수 있으므로 그 변경을 덮어쓰지 않도록 한다.
    const fresh = this.readFromDisk();
    const data = { ...fresh };
    if (binPath) data[provider] = binPath;
    else delete data[provider];
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), "utf8");
      // 디스크 성공 후에만 메모리 갱신 — 거짓 성공 상태 방지
      this.cache = data;
      return { ok: true };
    } catch (e) {
      console.error("[cli-discovery] override persist failed:", e);
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "EACCES" || code === "EPERM") {
        return {
          ok: false,
          reason: "permission_denied",
          message: `권한 거부: ${this.filePath}에 쓸 수 없습니다.`,
        };
      }
      if (code === "ENOSPC") {
        return {
          ok: false,
          reason: "disk_full",
          message: "디스크가 가득 찼습니다.",
        };
      }
      if (code === "EROFS") {
        return {
          ok: false,
          reason: "readonly_fs",
          message: "읽기 전용 파일시스템입니다.",
        };
      }
      return {
        ok: false,
        reason: "unknown",
        message:
          e instanceof Error
            ? `저장 실패: ${e.message}`
            : "알 수 없는 이유로 저장에 실패했습니다.",
      };
    }
  }

  private load(): Record<string, string> {
    if (this.cache) return this.cache;
    this.cache = this.readFromDisk();
    return this.cache;
  }

  // 디스크에서 fresh read. 손상된 JSON은 백업 후 빈 객체로 시작 — 사용자가
  // 수동 복구할 수 있게 원본을 보존하면서, 다음 set이 손상 파일을 그대로
  // 덮어쓰는 사고를 막는다.
  private readFromDisk(): Record<string, string> {
    if (!fs.existsSync(this.filePath)) return {};
    let raw = "";
    try {
      raw = fs.readFileSync(this.filePath, "utf8");
    } catch (e) {
      console.error("[cli-discovery] override read failed:", e);
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        return parsed as Record<string, string>;
      }
      // valid JSON이지만 객체 아님 — 손상으로 간주
      throw new Error("override JSON이 객체 형태가 아닙니다.");
    } catch (e) {
      const backup = `${this.filePath}.broken-${Date.now()}`;
      try {
        fs.renameSync(this.filePath, backup);
        console.error(
          `[cli-discovery] 손상된 override JSON 발견. 백업: ${backup}`,
          e,
        );
      } catch (renameErr) {
        console.error(
          "[cli-discovery] 손상된 override JSON 백업 실패:",
          renameErr,
        );
      }
      return {};
    }
  }
}

// ===== Orchestrator =====

class DefaultCliDiscovery implements CliDiscovery {
  private cachedEnv: NodeJS.ProcessEnv | null = null;
  private cachedEnvInflight: Promise<NodeJS.ProcessEnv> | null = null;

  constructor(
    private readonly pathSource: PathSource,
    private readonly verifier: Verifier,
    private readonly cache: DiscoveryCache,
    private readonly userOverride: UserOverrideStore,
  ) {}

  buildEnv(): Promise<NodeJS.ProcessEnv> {
    if (this.cachedEnv) return Promise.resolve(this.cachedEnv);
    if (this.cachedEnvInflight) return this.cachedEnvInflight;
    this.cachedEnvInflight = (async () => {
      const shellPath = await this.pathSource.capture();
      const existing = process.env.PATH || "";
      const merged = Array.from(
        new Set([
          ...shellPath,
          ...existing.split(path.delimiter).filter(Boolean),
        ]),
      );
      const baseEnv = process.env;
      this.cachedEnv = { ...baseEnv, PATH: merged.join(path.delimiter) };
      this.cachedEnvInflight = null;
      return this.cachedEnv;
    })();
    return this.cachedEnvInflight;
  }

  async find(provider: Provider): Promise<CliStatus> {
    const cached = this.cache.get(provider);
    if (cached) return cached;

    const command = PROVIDER_COMMANDS[provider];
    const env = await this.buildEnv();

    // 0) 사용자 수동 override 우선
    const override = this.userOverride.get(provider);
    if (override && fs.existsSync(override)) {
      const ok = await this.verifier.verify(override, env);
      const status: CliStatus = ok
        ? { installed: true, path: override, source: "override" }
        : {
            installed: false,
            path: null,
            source: "override",
            error: `사용자 지정 경로 ${override}이(가) --version 응답 없음`,
          };
      this.cache.set(provider, status);
      return status;
    }

    // PATH 전체(사용자 셸이 알려준 풍부한 PATH)를 walk해서 모든 후보 수집.
    // 셸 PATH가 진실의 소스다 — npm/bun/asdf/brew 어디에 깔든 사용자 셸이 잡아주면
    // 우리도 잡힌다. 하드코딩된 후보 디렉토리나 패키지 매니저 prefix 질의는 불필요.
    // PATH 첫 매치만 보지 않고 전체를 모으는 이유는 cmux wrapper 같은 트램폴린이
    // 실패해도 다음 후보(예: ~/.local/bin/claude)로 자동 fallback하기 위함.
    const candidates: string[] = [];
    const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      for (const filename of expandCandidateFilenames(command)) {
        const full = path.join(dir, filename);
        if (!fs.existsSync(full)) continue;
        if (candidates.includes(full)) continue;
        candidates.push(full);
      }
    }

    if (candidates.length === 0) {
      const status: CliStatus = {
        installed: false,
        path: null,
        source: "auto",
        error: `${command} CLI를 PATH 또는 알려진 설치 위치에서 찾지 못했습니다.`,
      };
      this.cache.set(provider, status);
      return status;
    }

    // 4) 후보 순서대로 verify, 첫 pass 채택
    const failed: string[] = [];
    for (const candidate of candidates) {
      const ok = await this.verifier.verify(candidate, env);
      if (ok) {
        const status: CliStatus = {
          installed: true,
          path: candidate,
          source: "auto",
        };
        this.cache.set(provider, status);
        return status;
      }
      failed.push(candidate);
    }

    // 모든 후보 verify 실패
    const preview = failed.slice(0, 3).join(", ");
    const more = failed.length > 3 ? ` 외 ${failed.length - 3}개` : "";
    const status: CliStatus = {
      installed: false,
      path: null,
      source: "auto",
      error: `${failed.length}개 후보(${preview}${more}) 모두 --version 응답이 없습니다.`,
    };
    this.cache.set(provider, status);
    return status;
  }

  invalidate(provider?: Provider): void {
    this.cache.invalidate(provider);
    if (!provider) {
      this.cachedEnv = null;
      this.cachedEnvInflight = null;
      this.pathSource.invalidate();
    }
  }

  setOverride(provider: Provider, binPath: string | null): OverrideSetResult {
    // 없는 경로를 저장하면 find()가 조용히 자동 탐지로 빠져 사용자가 실패를 모른다. 저장 전에 거른다.
    if (binPath) {
      let isFile = false;
      try {
        isFile = fs.statSync(binPath).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) {
        return { ok: false, reason: "not_found", message: `실행 파일이 없습니다: ${binPath}` };
      }
    }
    const result = this.userOverride.set(provider, binPath);
    // 디스크 persist 성공 시에만 캐시 무효화 → 다음 find()가 새 override 사용.
    // 실패 시엔 메모리/캐시 모두 그대로 → find()는 옛 결과 또는 자동 탐지 fallback.
    if (result.ok) this.cache.invalidate(provider);
    return result;
  }

  async listCandidates(provider: Provider): Promise<CliCandidate[]> {
    const command = PROVIDER_COMMANDS[provider];
    const env = await this.buildEnv();
    const seen = new Set<string>();
    const ordered: string[] = [];
    const pathDirs = (env.PATH || "").split(path.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      for (const filename of expandCandidateFilenames(command)) {
        const full = path.join(dir, filename);
        if (!fs.existsSync(full)) continue;
        if (seen.has(full)) continue;
        seen.add(full);
        ordered.push(full);
      }
    }
    // 모든 후보를 병렬로 verify해 1.5초 timeout 안에 끝나도록 한다.
    return Promise.all(
      ordered.map(async (p) => {
        const versionOutput = await captureVersion(p, env);
        return {
          path: p,
          verified: versionOutput !== null,
          versionOutput: versionOutput ?? undefined,
        };
      }),
    );
  }
}

function captureVersion(
  binPath: string,
  env: NodeJS.ProcessEnv,
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binPath,
      ["--version"],
      { timeout: 1500, env },
      (err, stdout, stderr) => {
        if (err) return resolve(null);
        const text = (stdout || stderr || "").toString().trim();
        if (!text) return resolve(null);
        resolve(text.split("\n")[0]);
      },
    );
  });
}

// ===== Factory =====

export interface BuildCliDiscoveryOptions {
  // userData/cli-overrides.json 경로. 미지정시 메모리에만 보관(영속화 X).
  overrideFilePath?: string;
}

export function buildCliDiscovery(
  options?: BuildCliDiscoveryOptions,
): CliDiscovery {
  const cache = new InMemoryDiscoveryCache();
  const userOverride: UserOverrideStore = options?.overrideFilePath
    ? new FileBasedUserOverrideStore(options.overrideFilePath)
    : new NoopUserOverrideStore();
  const verifier = new VersionFlagVerifier();

  if (process.platform === "win32") {
    return new DefaultCliDiscovery(
      new WindowsPathSource(),
      verifier,
      cache,
      userOverride,
    );
  }
  return new DefaultCliDiscovery(
    posixShellPathSource(),
    verifier,
    cache,
    userOverride,
  );
}
