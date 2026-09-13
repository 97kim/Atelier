import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  SessionManager,
  summarizeToolInput,
  type SessionSnapshot,
} from "./session-manager";

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function makeManager(root: string) {
  const snapshots: SessionSnapshot[] = [];
  let spawned: { hookLog: string | null; args: unknown[] } | null = null;
  const manager = new SessionManager({
    emit: () => {},
    claudeRuntime: () => Promise.reject(new Error("unused")),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({
      provider: "claude",
      cwd: root,
      policy: "ask",
      sessionId: "11111111-2222-3333-4444-555555555555",
    }),
    terminalCli: {
      async spawn(...args) {
        spawned = { hookLog: args[5], args };
      },
      kill() {},
    },
    transcriptRoots: { claude: join(root, "claude"), codex: join(root, "codex") },
    hookLogDir: join(root, "hooks"),
    onSnapshot: (_tabId, snap) => snapshots.push(snap),
  });
  return { manager, snapshots, spawned: () => spawned };
}

test("터미널 모드 권한 대기: 훅 로그의 PermissionRequest 로 켜지고, 키 입력·툴 종료·CLI 종료로 꺼진다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sess-"));
  const { manager, snapshots, spawned } = makeManager(root);
  const r = await manager.attachTerminal("tab1");
  assert.equal(r.ok, true);
  const hookLog = spawned()?.hookLog;
  assert.ok(hookLog && existsSync(hookLog), "훅 로그 파일이 미리 만들어진다");
  assert.equal(manager.snapshot("tab1").terminalAttention, null);

  const perm = (cmd: string) =>
    JSON.stringify({
      hook_event_name: "PermissionRequest",
      tool_name: "Bash",
      tool_input: { command: cmd },
    }) + "\n";
  appendFileSync(hookLog!, perm("git push"));
  await wait(600);
  assert.deepEqual(
    manager.snapshot("tab1").terminalAttention && {
      tool: manager.snapshot("tab1").terminalAttention!.tool,
      summary: manager.snapshot("tab1").terminalAttention!.summary,
    },
    { tool: "Bash", summary: "git push" },
  );
  assert.ok(snapshots.some((s) => s.terminalAttention?.summary === "git push"));

  // 다른 pty 입력(글자·방향키 ESC 시퀀스)은 무시, Enter 는 답한 것으로 본다.
  manager.terminalInput("tab1", "a");
  manager.terminalInput("tab1", "\x1b[B");
  assert.ok(manager.snapshot("tab1").terminalAttention);
  manager.terminalInput("tab1", "\r");
  assert.equal(manager.snapshot("tab1").terminalAttention, null);

  appendFileSync(hookLog!, perm("rm -rf build"));
  await wait(600);
  assert.equal(manager.snapshot("tab1").terminalAttention?.summary, "rm -rf build");
  // 다른 툴의 종료는 무시, 같은 툴의 종료는 해제
  appendFileSync(hookLog!, JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Read" }) + "\n");
  await wait(600);
  assert.ok(manager.snapshot("tab1").terminalAttention);
  appendFileSync(hookLog!, JSON.stringify({ hook_event_name: "PostToolUse", tool_name: "Bash" }) + "\n");
  await wait(600);
  assert.equal(manager.snapshot("tab1").terminalAttention, null);

  appendFileSync(hookLog!, perm("yarn test"));
  await wait(600);
  assert.ok(manager.snapshot("tab1").terminalAttention);
  manager.terminalExited("tab1");
  const after = manager.snapshot("tab1");
  assert.equal(after.controller, "app");
  assert.equal(after.terminalAttention, null);
  assert.equal(existsSync(hookLog!), false, "CLI 종료 후 훅 로그는 지운다");
  rmSync(root, { recursive: true, force: true });
});

test("터미널 모드: 훅이 다른 세션 id 를 알리면(TUI 안 /resume) 그 세션의 기록을 불러오고 미러가 그 파일을 따라간다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-switch-"));
  const { manager, spawned } = makeManager(root);
  const r = await manager.attachTerminal("tab1");
  assert.equal(r.ok, true);
  const hookLog = spawned()!.hookLog!;
  assert.equal(manager.snapshot("tab1").sessionId, "11111111-2222-3333-4444-555555555555");
  // 갈아탈 세션 "other" 의 기록: 한 턴(user + assistant end_turn)
  const dir = join(root, "claude", "-Users-x-proj");
  mkdirSync(dir, { recursive: true });
  const file = join(dir, "other.jsonl");
  const line = (o: unknown) => JSON.stringify(o) + "\n";
  writeFileSync(
    file,
    line({ type: "user", uuid: "u1", timestamp: "2026-09-09T00:00:00Z", message: { role: "user", content: "예전 질문" } }) +
      line({ type: "assistant", timestamp: "2026-09-09T00:00:01Z", message: { id: "m1", role: "assistant", content: [{ type: "text", text: "예전 답" }], stop_reason: "end_turn", usage: {} } }),
  );
  // 훅: 프롬프트 제출 시 session_id 가 바뀌어 있다
  appendFileSync(hookLog, line({ hook_event_name: "UserPromptSubmit", session_id: "other", transcript_path: file, prompt: "새 질문" }));
  await wait(700);
  assert.equal(manager.snapshot("tab1").sessionId, "other");
  const types = manager.events("tab1").map((e) => e.type);
  assert.ok(types.includes("error"), "갈아탐 안내 한 줄");
  assert.ok(manager.events("tab1").some((e) => e.type === "user_message" && e.text === "예전 질문"), "그 세션의 이전 대화를 불러온다");
  assert.ok(manager.events("tab1").some((e) => e.type === "assistant_text" && e.text === "예전 답"));
  const before = manager.events("tab1").length;
  // 이어지는 대화는 미러가 그 파일에서 읽는다(중복 없이)
  appendFileSync(file, line({ type: "user", uuid: "u2", timestamp: "2026-09-09T00:00:02Z", message: { role: "user", content: "새 질문" } }));
  await wait(1200);
  const after = manager.events("tab1");
  assert.equal(after.filter((e) => e.type === "user_message" && e.text === "새 질문").length, 1);
  assert.equal(after.filter((e) => e.type === "user_message" && e.text === "예전 질문").length, 1, "이전 대화가 두 번 들어가지 않는다");
  assert.equal(after.length, before + 1);
  manager.release("tab1");
  rmSync(root, { recursive: true, force: true });
});

test("summarizeToolInput: Bash 는 설명 또는 명령 첫 줄, 파일 툴은 경로", () => {
  assert.equal(summarizeToolInput("Bash", { command: "ls\npwd" }), "ls");
  assert.equal(
    summarizeToolInput("Bash", { command: "ls", description: "목록" }),
    "목록",
  );
  assert.equal(summarizeToolInput("Edit", { file_path: "/a/b.ts" }), "/a/b.ts");
  assert.equal(summarizeToolInput("WebFetch", { url: "https://x" }), "https://x");
  assert.equal(summarizeToolInput("Foo", {}), "");
});

test("프롬프트 큐 영속화: 세션 생성 시 복원, 편집·제거는 저장, 닫기/종료는 남기고 사용자 중단은 버린다", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sessq-"));
  const saved = new Map<string, unknown[]>();
  const ev = { type: "user_message" as const, ts: 1, text: "다음 지시" };
  saved.set("tab1", [{ id: "q1", text: "다음 지시", images: [], userEvent: ev }, { id: "q2", text: "그 다음", images: [], userEvent: ev }]);
  const mk = () =>
    new SessionManager({
      emit: () => {},
      claudeRuntime: () => Promise.reject(new Error("unused")),
      codexRuntime: () => Promise.reject(new Error("unused")),
      resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
      store: {
        appendEvent() {},
        readEvents: () => [],
        resetThread() {},
        savePromptQueue: (tabId, items) => saved.set(tabId, items.map((i) => ({ ...i }))),
        loadPromptQueue: (tabId) => (saved.get(tabId) ?? []) as never,
      },
    });
  const m = mk();
  assert.deepEqual(
    m.snapshot("tab1").pendingPrompts.map((p) => p.id),
    ["q1", "q2"],
    "저장돼 있던 큐가 복원된다",
  );
  m.queueUpdate("tab1", "q2", "고친 지시");
  assert.equal((saved.get("tab1") as { text: string }[])[1].text, "고친 지시");
  m.queueRemove("tab1", "q1");
  assert.deepEqual((saved.get("tab1") as { id: string }[]).map((p) => p.id), ["q2"]);
  // 탭 닫기(release)·앱 종료(shutdown)는 큐를 남긴다
  m.release("tab1");
  assert.equal(saved.get("tab1")!.length, 1);
  const m2 = mk();
  assert.deepEqual(m2.snapshot("tab1").pendingPrompts.map((p) => p.id), ["q2"]);
  m2.shutdown();
  assert.equal(saved.get("tab1")!.length, 1);
  // 사용자의 중단은 버린다
  const m3 = mk();
  assert.equal(m3.snapshot("tab1").pendingPrompts.length, 1);
  m3.abort("tab1");
  assert.equal(saved.get("tab1")!.length, 0);
  assert.equal(m3.snapshot("tab1").pendingPrompts.length, 0);
  rmSync(root, { recursive: true, force: true });
});

test("Codex 터미널 모드 승인 힌트: pty 출력의 프롬프트로 켜지고, 키 입력·'Approved action'·CLI 종료로 꺼진다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-codexattn-"));
  const { manager, snapshots } = makeManager(root);
  manager.configure("cx", { provider: "codex" });
  const r = await manager.attachTerminal("cx");
  assert.equal(r.ok, true);
  manager.terminalOutput("cx", "\x1b[33mAllow Codex to ru");
  assert.equal(manager.snapshot("cx").terminalAttention, null, "잘린 문장으로는 아직");
  manager.terminalOutput("cx", "n `curl -sI https://example.com`\x1b[0m?");
  assert.deepEqual(
    manager.snapshot("cx").terminalAttention && { tool: manager.snapshot("cx").terminalAttention!.tool, summary: manager.snapshot("cx").terminalAttention!.summary },
    { tool: "명령 실행", summary: "curl -sI https://example.com" },
  );
  assert.ok(snapshots.some((s) => s.terminalAttention?.summary === "curl -sI https://example.com"));
  manager.terminalInput("cx", "\x1b[B"); // 방향키는 답이 아님
  assert.ok(manager.snapshot("cx").terminalAttention);
  manager.terminalInput("cx", "\r");
  assert.equal(manager.snapshot("cx").terminalAttention, null);
  manager.terminalOutput("cx", "Codex wants to edit src/a.ts");
  assert.equal(manager.snapshot("cx").terminalAttention?.tool, "파일 수정");
  manager.terminalOutput("cx", "Approved action: edit");
  assert.equal(manager.snapshot("cx").terminalAttention, null);
  manager.terminalOutput("cx", "Yes, grant these permissions for this turn");
  assert.equal(manager.snapshot("cx").terminalAttention?.tool, "권한 요청");
  manager.terminalExited("cx");
  assert.equal(manager.snapshot("cx").terminalAttention, null);
  // Claude 탭의 출력은 무시한다(훅이 담당)
  await manager.attachTerminal("cl");
  manager.terminalOutput("cl", "Allow Codex to run `ls`");
  assert.equal(manager.snapshot("cl").terminalAttention, null);
  manager.shutdown(); // 미러·훅 워처를 내려야 테스트 프로세스가 끝난다
  rmSync(root, { recursive: true, force: true });
});

test("프롬프트 큐: 실행 중 탭 닫기(release)는 큐를 보내지 않고 남기고, 오류로 멈춘 뒤 '지금 보내기' 는 보낸다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sessq2-"));
  const saved = new Map<string, unknown[]>();
  const recorded: string[] = [];
  const mk = (runtimeDelayMs: number) =>
    new SessionManager({
      emit: () => {},
      // 런타임 준비가 실패하는 것으로 턴을 끝낸다(지연을 주면 그 사이 큐에 넣고 닫을 수 있다)
      claudeRuntime: () => new Promise((_, rej) => setTimeout(() => rej(new Error("runtime unavailable")), runtimeDelayMs)),
      codexRuntime: () => Promise.reject(new Error("unused")),
      resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
      store: {
        appendEvent: (_t, e) => {
          if (e.type === "user_message") recorded.push(e.text);
        },
        readEvents: () => [],
        resetThread() {},
        savePromptQueue: (tabId, items) => saved.set(tabId, items.map((i) => ({ ...i }))),
        loadPromptQueue: (tabId) => (saved.get(tabId) ?? []) as never,
      },
    });
  const ev = (text: string) => ({ type: "user_message" as const, id: `u-${text}`, ts: 1, text }) as never;

  // 1) 실행 중 release → 큐는 디스크에 남고, 닫힌 탭에서 새 턴이 시작되지 않는다
  const m = mk(150);
  assert.equal((await m.send("t1", "첫 지시", [], ev("첫 지시"))).ok, true);
  const q = await m.send("t1", "대기 지시", [], ev("대기 지시"));
  assert.equal(q.ok && q.pending, true);
  assert.equal(saved.get("t1")!.length, 1);
  m.release("t1");
  await wait(400);
  assert.equal(saved.get("t1")!.length, 1, "닫기가 큐를 소비하면 안 된다");
  assert.deepEqual(recorded, ["첫 지시"], "대기 지시가 전송되면 안 된다");

  // 2) 오류로 끝난 뒤: 자동으로는 안 보내고, '지금 보내기' 로는 보낸다
  recorded.length = 0;
  saved.clear();
  const m2 = mk(0);
  assert.equal((await m2.send("t2", "A", [], ev("A"))).ok, true);
  assert.equal((await m2.send("t2", "B", [], ev("B"))).ok, true);
  await wait(200);
  assert.equal(m2.snapshot("t2").status, "error");
  assert.equal(m2.snapshot("t2").pendingPrompts.length, 1, "오류 뒤 자동 전송 안 함");
  m2.queueSendNext("t2");
  await wait(200);
  assert.deepEqual(recorded, ["A", "B"]);
  assert.equal(m2.snapshot("t2").pendingPrompts.length, 0);
  m.shutdown();
  m2.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("닫은 탭: 늦게 끝난 턴의 정리가 세션을 되살리거나 스냅샷을 보내지 않는다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sessrel-"));
  const snaps: string[] = [];
  const m = new SessionManager({
    emit: () => {},
    // 런타임 준비가 늦게 실패한다 — 그 사이에 탭을 닫으면 턴은 release 뒤에 끝난다
    claudeRuntime: () => new Promise((_, rej) => setTimeout(() => rej(new Error("runtime unavailable")), 150)),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
    onSnapshot: (tabId) => snaps.push(tabId),
  });
  assert.equal((await m.send("t1", "지시", [], { type: "user_message", id: "u1", ts: 1, text: "지시" } as never)).ok, true);
  m.release("t1");
  snaps.length = 0;
  await wait(400);
  assert.deepEqual(snaps, [], "닫힌 탭에 스냅샷을 보내면 안 된다 (snapshot() 의 ensure 가 세션을 되살린다)");
  m.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("동시 실행 상한: 넘치면 queued + 순번/진행 중 수, 자리가 나거나 상한을 올리면 시작, 기다리는 탭에 스냅샷을 밀어 준다", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-conc-"));
  const snapshots: SessionSnapshot[] = [];
  const m = new SessionManager({
    emit: () => {},
    // 런타임 준비를 300ms 끌어서 그동안 "running" 으로 둔다
    claudeRuntime: () => new Promise((_, rej) => setTimeout(() => rej(new Error("runtime unavailable")), 300)),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
    maxConcurrent: 1,
    onSnapshot: (_t, s) => snapshots.push(s),
  });
  const ev = (text: string) => ({ type: "user_message" as const, id: `u-${text}`, ts: 1, text }) as never;
  assert.deepEqual(await m.send("a", "A", [], ev("A")), { ok: true, queued: false });
  assert.deepEqual(await m.send("b", "B", [], ev("B")), { ok: true, queued: true });
  assert.deepEqual(await m.send("c", "C", [], ev("C")), { ok: true, queued: true });
  assert.equal(m.snapshot("a").queueInfo, null);
  assert.deepEqual(m.snapshot("b").queueInfo, { position: 1, running: 1, max: 1, waitingPermission: 0 });
  assert.deepEqual(m.snapshot("c").queueInfo, { position: 2, running: 1, max: 1, waitingPermission: 0 });
  // 상한을 올리면 b 가 바로 시작하고 c 는 1번째로 당겨진다(스냅샷 푸시)
  snapshots.length = 0;
  m.setMaxConcurrent(2);
  assert.equal(m.snapshot("b").status, "running");
  assert.deepEqual(m.snapshot("c").queueInfo, { position: 1, running: 2, max: 2, waitingPermission: 0 });
  assert.ok(snapshots.some((s) => s.tabId === "c" && s.queueInfo?.position === 1 && s.queueInfo.running === 2));
  // 내려도 진행 중인 둘은 그대로, c 는 계속 기다린다
  m.setMaxConcurrent(1);
  assert.equal(m.snapshot("a").status, "running");
  assert.equal(m.snapshot("b").status, "running");
  assert.equal(m.snapshot("c").status, "queued");
  // a·b 가 끝나면(오류) 자리가 나서 c 가 시작한다
  await wait(500);
  assert.equal(m.snapshot("c").queueInfo, null);
  assert.notEqual(m.snapshot("c").status, "queued");
  await wait(500);
  m.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("한도 재시도(실제 턴 경로): 한도 오류 → limitWait 예약, 재시도 3회 넘기면 멈춤, 대기 중 큐는 멈춰 있음", async () => {
  const root = mkdtempSync(join(tmpdir(), "wb-limit-"));
  const resetSec = Math.floor(Date.now() / 1000) + 120;
  let runtimeCalls = 0;
  const m = new SessionManager({
    emit: () => {},
    claudeRuntime: () => {
      runtimeCalls++;
      return Promise.reject(new Error(`Claude AI usage limit reached|${resetSec}`));
    },
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: root, policy: "ask", sessionId: null }),
  });
  const ev = (text: string) => ({ type: "user_message" as const, id: `u-${text}`, ts: 1, text }) as never;
  assert.equal((await m.send("t", "A", [], ev("A"))).ok, true);
  await wait(100);
  let snap = m.snapshot("t");
  assert.equal(runtimeCalls, 1);
  assert.ok(snap.limitWait, "한도 오류면 재시도가 예약된다");
  assert.equal(snap.limitWait!.attempts, 1);
  assert.equal(snap.limitWait!.until, resetSec * 1000, "리셋 시각은 오류 텍스트의 |epoch");
  // 대기 중 보낸 지시는 큐에 남고 자동으로 나가지 않는다
  const q = await m.send("t", "B", [], ev("B"));
  assert.equal(q.ok && q.pending, true);
  assert.equal(m.snapshot("t").pendingPrompts.length, 1);
  // "지금 재시도" 를 반복 → 같은 한도에 계속 걸리면 3회 뒤 멈춘다
  m.limitRetryNow("t");
  await wait(100);
  assert.equal(runtimeCalls, 2);
  assert.equal(m.snapshot("t").limitWait?.attempts, 2);
  m.limitRetryNow("t");
  await wait(100);
  m.limitRetryNow("t");
  await wait(100);
  snap = m.snapshot("t");
  assert.equal(runtimeCalls, 4);
  assert.equal(snap.limitWait?.attempts, 4);
  assert.equal(snap.limitWait?.until, null, "상한을 넘기면 예약 없이 멈춘다");
  assert.equal(snap.pendingPrompts.length, 1, "큐는 그대로");
  // 취소하면 예약이 지워진다
  m.limitCancel("t");
  assert.equal(m.snapshot("t").limitWait, null);
  m.shutdown();
  rmSync(root, { recursive: true, force: true });
});

test("inheritCwd: 워크스페이스 기본 경로가 바뀌면 물려받는 탭의 세션 cwd 를 맞추고 세션 id 를 비운다(탭에 경로는 박지 않음)", () => {
  const root = mkdtempSync(join(tmpdir(), "wb-sess-"));
  const metas: unknown[] = [];
  const snapshots: SessionSnapshot[] = [];
  const manager = new SessionManager({
    emit: () => {},
    claudeRuntime: () => Promise.reject(new Error("unused")),
    codexRuntime: () => Promise.reject(new Error("unused")),
    resolveConfig: () => ({ provider: "claude", cwd: join(root, "old"), policy: "ask", sessionId: "s-old" }),
    transcriptRoots: { claude: join(root, "claude"), codex: join(root, "codex") },
    hookLogDir: join(root, "hooks"),
    onMeta: (_tabId, meta) => metas.push(meta),
    onSnapshot: (_tabId, snap) => snapshots.push(snap),
  });
  // 아직 세션이 없는 탭은 손대지 않는다 (다음 ensure 가 새 경로로 만든다)
  manager.inheritCwd("t0", join(root, "new"));
  assert.deepEqual(metas, []);

  assert.equal(manager.snapshot("t1").cwd, join(root, "old"));
  assert.equal(manager.snapshot("t1").sessionId, "s-old");
  manager.inheritCwd("t1", join(root, "new"));
  assert.equal(manager.snapshot("t1").cwd, join(root, "new"));
  assert.equal(manager.snapshot("t1").sessionId, null);
  assert.deepEqual(metas, [{ sessionId: null }]);
  assert.equal(snapshots.at(-1)?.cwd, join(root, "new"));

  // 같은 경로면 아무 일도 없다
  const n = metas.length;
  manager.inheritCwd("t1", join(root, "new"));
  assert.equal(metas.length, n);
  rmSync(root, { recursive: true, force: true });
});
