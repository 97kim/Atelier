// 세션별 git worktree: 같은 저장소에서 세션 여러 개가 서로 파일을 건드리지 않게 탭마다 브랜치+작업 트리를 따로 준다.
// worktree 는 저장소 밖(userData/worktrees/<repo>/<slug>)에 만들어 원본에 untracked 파일로 보이지 않게 한다.
import { execFile } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import type { WorktreeMeta } from "@shared/workspace-model";
import type { GitChangeDto } from "@shared/ipc";

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function run(cwd: string, args: string[], env: NodeJS.ProcessEnv): Promise<Run> {
  return new Promise((resolve) => {
    execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, env, timeout: 30000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: unknown }).code : 0;
      resolve({ code: typeof raw === "number" ? raw : err ? 1 : 0, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() || (err ? err.message : "") });
    });
  });
}

const ok = (r: Run) => (r.code === 0 ? r.stdout.trim() : null);

/** 브랜치·디렉토리 이름으로 쓸 수 있게: 소문자, 영숫자·한글·-·_ 만, 24자. */
export function worktreeSlug(raw: string, now = Date.now()): string {
  const base = raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}_-]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  const stamp = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${base || "session"}-${pad(stamp.getMonth() + 1)}${pad(stamp.getDate())}-${pad(stamp.getHours())}${pad(stamp.getMinutes())}`;
}

export async function worktreeCreate(
  repoCwd: string,
  env: NodeJS.ProcessEnv,
  opts: { rootDir: string; slug: string },
): Promise<{ ok: true; worktree: WorktreeMeta } | { ok: false; error: string }> {
  const top = ok(await run(repoCwd, ["rev-parse", "--show-toplevel"], env));
  if (!top) return { ok: false, error: "git 저장소가 아닙니다." };
  const head = ok(await run(top, ["rev-parse", "--verify", "-q", "HEAD"], env));
  if (!head) return { ok: false, error: "커밋이 하나도 없는 저장소에는 worktree 를 만들 수 없습니다." };
  const baseRef = ok(await run(top, ["rev-parse", "--abbrev-ref", "HEAD"], env));
  if (!baseRef || baseRef === "HEAD")
    return { ok: false, error: "원본 저장소가 브랜치가 아닌 커밋(detached HEAD)에 있습니다. 브랜치로 체크아웃한 뒤 만드세요." };
  const base = baseRef;
  const dir = join(opts.rootDir, basename(top));
  fs.mkdirSync(dir, { recursive: true });
  // 이름 충돌 회피
  let slug = opts.slug;
  for (let i = 2; fs.existsSync(join(dir, slug)) || (await run(top, ["rev-parse", "--verify", "-q", `refs/heads/atelier/${slug}`], env)).code === 0; i++)
    slug = `${opts.slug}-${i}`;
  const path = join(dir, slug);
  const branch = `atelier/${slug}`;
  const r = await run(top, ["worktree", "add", "-b", branch, path, "HEAD"], env);
  if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "git worktree add 실패" };
  return { ok: true, worktree: { repo: top, path, branch, base } };
}

export interface WorktreeStatus {
  exists: boolean;
  /** base 브랜치가 사라졌으면 true — 가져오기를 막는다. */
  baseMissing: boolean;
  /** base 에 없는 이 브랜치의 커밋 수. */
  ahead: number;
  /** 이 브랜치에 없는 base 의 커밋 수. */
  behind: number;
  /** 커밋되지 않은 변경 파일 수. */
  dirty: number;
}

export async function worktreeStatus(env: NodeJS.ProcessEnv, wt: WorktreeMeta): Promise<WorktreeStatus> {
  if (!fs.existsSync(wt.path)) return { exists: false, baseMissing: false, ahead: 0, behind: 0, dirty: 0 };
  const baseMissing = (await run(wt.repo, ["rev-parse", "--verify", "-q", `refs/heads/${wt.base}`], env)).code !== 0;
  const count = async (range: string) => Number(ok(await run(wt.repo, ["rev-list", "--count", range], env)) ?? 0);
  const status = ok(await run(wt.path, ["status", "--porcelain", "-z", "--untracked-files=all"], env)) ?? "";
  // -z 는 rename 의 옛 경로를 별도 필드로 내보낸다 — 그 필드는 파일로 세지 않는다.
  let dirty = 0;
  const fields = status ? status.split("\0") : [];
  for (let i = 0; i < fields.length; i++) {
    const f = fields[i];
    if (f.length < 4) continue;
    dirty++;
    if (/[RC]/.test(f.slice(0, 2))) i++;
  }
  return {
    exists: true,
    baseMissing,
    ahead: baseMissing ? 0 : await count(`${wt.base}..${wt.branch}`),
    behind: baseMissing ? 0 : await count(`${wt.branch}..${wt.base}`),
    dirty,
  };
}

/**
 * 이 세션의 커밋을 base 로 가져온다(원본 저장소에서 merge). 원본이 base 브랜치에 있어야 하고 worktree 에 미커밋 변경이 없어야 한다.
 * 충돌이 나면 merge 를 되돌리고 오류로 알린다.
 */
export async function worktreeMerge(
  env: NodeJS.ProcessEnv,
  wt: WorktreeMeta,
): Promise<{ ok: true; merged: number } | { ok: false; error: string }> {
  const st = await worktreeStatus(env, wt);
  if (!st.exists) return { ok: false, error: "worktree 가 없습니다." };
  if (st.baseMissing) return { ok: false, error: `base 브랜치 ${wt.base} 가 없습니다. 브랜치를 복구하거나 수동으로 merge 하세요.` };
  if (st.dirty > 0) return { ok: false, error: `worktree 에 커밋되지 않은 변경 ${st.dirty}개가 있습니다. 먼저 커밋하거나 버리세요.` };
  if (st.ahead === 0) return { ok: true, merged: 0 };
  const cur = ok(await run(wt.repo, ["rev-parse", "--abbrev-ref", "HEAD"], env));
  if (cur !== wt.base) return { ok: false, error: `원본 저장소가 ${wt.base} 가 아니라 ${cur ?? "?"} 에 있습니다. ${wt.base} 로 체크아웃한 뒤 가져오세요.` };
  const repoDirty = ok(await run(wt.repo, ["status", "--porcelain", "--untracked-files=no"], env)) ?? "";
  if (repoDirty) return { ok: false, error: "원본 저장소에 커밋되지 않은 변경이 있습니다. 먼저 커밋하거나 stash 하세요." };
  const m = await run(wt.repo, ["merge", "--no-edit", wt.branch], env);
  if (m.code !== 0) {
    await run(wt.repo, ["merge", "--abort"], env);
    return { ok: false, error: `merge 충돌로 되돌렸습니다: ${(m.stdout + m.stderr).trim().split("\n").slice(-3).join(" ")}` };
  }
  return { ok: true, merged: st.ahead };
}

/** worktree 를 지운다. 미커밋 변경이 있으면 force 없이는 거부. 브랜치는 base 에 합쳐졌을 때만 지운다(-d). */
/**
 * 치우기 전에 남은 것을 제 브랜치에 커밋해 둔다. 폴더는 회수하면서 결과는 잃지 않으려는 것이다.
 *
 * 격리 회차의 작업 폴더는 거의 항상 더럽다 — 예약이 만든 파일뿐 아니라 도구가 작업 디렉터리에
 * 쓰는 상태(.omc 등)도 같이 남는다. 그래서 "더러우면 안 치운다" 로만 두면 아무것도 치우지 못한다.
 *
 * 커밋만 하고 브랜치는 지우지 않는다(worktreeRemove 의 `branch -d` 는 병합 안 된 브랜치를 거부한다).
 * 나중에 `git switch atelier/<이름>` 으로 그대로 꺼내 볼 수 있다.
 */
export async function worktreeArchive(
  env: NodeJS.ProcessEnv,
  wt: WorktreeMeta,
  message: string,
): Promise<{ ok: true; committed: boolean } | { ok: false; error: string }> {
  if (!fs.existsSync(wt.path)) return { ok: true, committed: false };
  const st = await worktreeStatus(env, wt);
  if (st.dirty === 0) return { ok: true, committed: false };
  const add = await run(wt.path, ["add", "-A"], env);
  if (add.code !== 0) return { ok: false, error: add.stderr.trim() || "git add 실패" };
  const c = await run(wt.path, ["commit", "-m", message], env);
  // 커밋할 것이 없다고 나오는 경우(무시된 파일만 있었다)는 실패가 아니다.
  if (c.code !== 0 && !/nothing to commit|작성할 내용 없음/.test(c.stdout + c.stderr))
    return { ok: false, error: c.stderr.trim() || c.stdout.trim() || "git commit 실패" };
  return { ok: true, committed: c.code === 0 };
}

export async function worktreeRemove(
  env: NodeJS.ProcessEnv,
  wt: WorktreeMeta,
  opts: { force?: boolean } = {},
): Promise<{ ok: true; branchDeleted: boolean } | { ok: false; error: string }> {
  if (fs.existsSync(wt.path)) {
    const st = await worktreeStatus(env, wt);
    if (st.dirty > 0 && !opts.force)
      return { ok: false, error: `worktree 에 커밋되지 않은 변경 ${st.dirty}개가 있습니다.` };
    const r = await run(wt.repo, ["worktree", "remove", ...(opts.force ? ["--force"] : []), wt.path], env);
    if (r.code !== 0) return { ok: false, error: r.stderr.trim() || "git worktree remove 실패" };
  } else {
    await run(wt.repo, ["worktree", "prune"], env);
  }
  const del = await run(wt.repo, ["branch", "-d", wt.branch], env);
  return { ok: true, branchDeleted: del.code === 0 };
}

function runInput(cwd: string, args: string[], env: NodeJS.ProcessEnv, input: string): Promise<Run> {
  return new Promise((resolve) => {
    const p = execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, env, timeout: 30000, maxBuffer: 32 * 1024 * 1024 }, (err, stdout, stderr) => {
      const raw = err ? (err as { code?: unknown }).code : 0;
      resolve({ code: typeof raw === "number" ? raw : err ? 1 : 0, stdout: stdout?.toString() ?? "", stderr: stderr?.toString() || (err ? err.message : "") });
    });
    p.stdin?.end(input);
  });
}

/** base 브랜치와 갈라진 지점(merge-base). base 가 없으면 null. */
export async function worktreeBase(env: NodeJS.ProcessEnv, wt: WorktreeMeta): Promise<string | null> {
  return ok(await run(wt.repo, ["merge-base", wt.base, wt.branch], env)) ?? ok(await run(wt.repo, ["rev-parse", wt.base], env));
}

/**
 * 임시 인덱스(GIT_INDEX_FILE)에 HEAD + 작업 트리 전부(add -A, 새 파일 포함)를 올리고 fn 을 돌린다.
 * 실제 인덱스는 건드리지 않는다 — 변형이 일부만 스테이징해 둔 상태를 잃지 않게.
 */
async function withStagedSnapshot<T>(env: NodeJS.ProcessEnv, wt: WorktreeMeta, fn: (env2: NodeJS.ProcessEnv) => Promise<T>): Promise<T | { ok: false; error: string }> {
  const tmp = join(tmpdir(), `atelier-index-${process.pid}-${randomUUID()}`);
  const env2 = { ...env, GIT_INDEX_FILE: tmp };
  try {
    const rt = await run(wt.path, ["read-tree", "HEAD"], env2);
    if (rt.code !== 0) return { ok: false, error: rt.stderr.trim() || "git read-tree 실패" };
    const add = await run(wt.path, ["add", "-A"], env2);
    if (add.code !== 0) return { ok: false, error: add.stderr.trim() || "git add 실패" };
    return await fn(env2);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

export interface WorktreeSnapshot {
  ok: true;
  base: string;
  /** base 이후의 모든 변경(커밋 + 작업 트리 + 새 파일), 경로별 +/- 줄 수. */
  changes: GitChangeDto[];
  /** 경로별 unified diff(요청했을 때만). */
  diffs: Record<string, string>;
}

/**
 * 변형의 변경 전체를 base(merge-base) 기준으로 본다 — 카드 통계·비교 화면·채택 패치가 모두 이 한 기준을 쓴다.
 * (HEAD 기준 작업 트리만 보면 변형이 커밋해 버린 변경이 빠진다.)
 */
export async function worktreeSnapshot(env: NodeJS.ProcessEnv, wt: WorktreeMeta, opts: { diffs?: boolean; maxDiffFiles?: number } = {}): Promise<WorktreeSnapshot | { ok: false; error: string }> {
  if (!fs.existsSync(wt.path)) return { ok: false, error: "worktree 가 없습니다." };
  const base = await worktreeBase(env, wt);
  if (!base) return { ok: false, error: `base 브랜치 ${wt.base} 를 찾지 못했습니다.` };
  return withStagedSnapshot(env, wt, async (env2) => {
    const ns = await run(wt.path, ["diff", "--cached", "--numstat", "-z", "-M", base], env2);
    if (ns.code !== 0) return { ok: false as const, error: ns.stderr.trim() || "git diff 실패" };
    const st = await run(wt.path, ["diff", "--cached", "--name-status", "-z", "-M", base], env2);
    const kinds = new Map<string, { kind: GitChangeDto["kind"]; oldPath?: string }>();
    const sf = st.stdout.split("\0");
    for (let i = 0; i < sf.length; i++) {
      const code = sf[i];
      if (!code) continue;
      if (/^[RC]/.test(code)) {
        const oldPath = sf[i + 1] ?? "";
        const path = sf[i + 2] ?? "";
        kinds.set(path, { kind: "renamed", oldPath });
        i += 2;
      } else {
        const path = sf[i + 1] ?? "";
        kinds.set(path, { kind: code === "A" ? "added" : code === "D" ? "deleted" : "modified" });
        i += 1;
      }
    }
    const changes: GitChangeDto[] = [];
    const nf = ns.stdout.split("\0");
    for (let i = 0; i < nf.length; i++) {
      const m = nf[i].match(/^(\d+|-)\t(\d+|-)\t(.*)$/);
      if (!m) continue;
      let path = m[3];
      if (path === "") {
        // 이름 변경: 뒤에 old, new 가 별도 필드
        path = nf[i + 2] ?? "";
        i += 2;
      }
      const k = kinds.get(path) ?? { kind: "modified" as const };
      changes.push({ path, kind: k.kind, ...(k.oldPath ? { oldPath: k.oldPath } : {}), added: m[1] === "-" ? 0 : Number(m[1]), deleted: m[2] === "-" ? 0 : Number(m[2]) });
    }
    const diffs: Record<string, string> = {};
    if (opts.diffs) {
      for (const c of changes.slice(0, opts.maxDiffFiles ?? 60)) {
        const d = await run(wt.path, ["diff", "--cached", "--no-color", "-M", base, "--", `:(literal)${c.path}`, ...(c.oldPath ? [`:(literal)${c.oldPath}`] : [])], env2);
        diffs[c.path] = d.stdout.length > 40_000 ? `${d.stdout.slice(0, 40_000)}\n... (diff 가 길어 생략)` : d.stdout;
      }
    }
    return { ok: true as const, base, changes, diffs };
  });
}

/** worktree 의 모든 변경(커밋한 것 + 작업 트리 + 새 파일)을 base 기준 패치 하나로(팬아웃 채택용). 실제 인덱스는 보존된다. */
export async function worktreePatch(env: NodeJS.ProcessEnv, wt: WorktreeMeta): Promise<{ ok: true; patch: string; base: string } | { ok: false; error: string }> {
  if (!fs.existsSync(wt.path)) return { ok: false, error: "worktree 가 없습니다." };
  const base = await worktreeBase(env, wt);
  if (!base) return { ok: false, error: `base 브랜치 ${wt.base} 를 찾지 못했습니다.` };
  return withStagedSnapshot(env, wt, async (env2) => {
    const d = await run(wt.path, ["diff", "--cached", "--binary", "--no-color", base], env2);
    if (d.code !== 0) return { ok: false as const, error: d.stderr.trim() || "git diff 실패" };
    return { ok: true as const, patch: d.stdout, base };
  });
}

/** 패치를 저장소 작업 트리에 적용한다(인덱스는 건드리지 않음). 먼저 --check 로 깨끗이 들어가는지 본다. */
export async function applyPatch(env: NodeJS.ProcessEnv, cwd: string, patch: string): Promise<{ ok: true; files: string[] } | { ok: false; error: string }> {
  if (!patch.trim()) return { ok: true, files: [] };
  const top = ok(await run(cwd, ["rev-parse", "--show-toplevel"], env));
  if (!top) return { ok: false, error: "git 저장소가 아닙니다." };
  const check = await runInput(top, ["apply", "--check", "--binary", "--whitespace=nowarn", "-"], env, patch);
  if (check.code !== 0) return { ok: false, error: `패치가 깨끗이 적용되지 않습니다: ${check.stderr.trim().split("\n").slice(0, 3).join(" ")}` };
  const stat = await runInput(top, ["apply", "--numstat", "--binary", "-"], env, patch);
  const files = stat.stdout.split("\n").filter(Boolean).map((l) => l.split("\t")[2]).filter((f): f is string => !!f);
  const a = await runInput(top, ["apply", "--binary", "--whitespace=nowarn", "-"], env, patch);
  if (a.code !== 0) return { ok: false, error: a.stderr.trim() || "git apply 실패" };
  return { ok: true, files };
}
