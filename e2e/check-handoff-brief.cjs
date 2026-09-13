// 크로스 provider 전환. Claude 와 Codex 는 세션을 이어받을 수 없어 텍스트로 넘길 수밖에 없는데,
// 그 텍스트를 우리가 기록을 잘라 만드느냐, 떠나는 쪽이 직접 쓰느냐가 갈린다. 확인할 것 —
// (1) askSummary 를 켜면 모델이 쓴 인계서가 넘어가는가 (우리가 만든 기계 요약이 아니라)
// (2) 그 인계서가 디스크에 남아 앱을 껐다 켜도 살아남는가
const fs = require("fs"), path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Atelier.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Atelier", [app + "/Contents/Resources/cli/atelier.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ATELIER_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "인계", "--activate");
  await page.waitForTimeout(2500);

  const tabId = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab") ?? null);
  if (!tabId) { console.log("RESULT: FAIL (탭을 못 찾음)"); process.exit(1); }
  const snap = () => ev((id) => window.workbench.chat.snapshot(id), tabId);
  const settle = async (label) => {
    for (let i = 0; i < 240; i++) {
      const s = await snap();
      if (s.sessionId && s.status !== "running" && s.status !== "queued" && s.status !== "waiting_permission") return s;
      await page.waitForTimeout(1000);
    }
    throw new Error(`${label}: 턴이 안 끝남`);
  };

  // 넘길 맥락을 만든다 — 의도와 결정이 있어야 인계서에 담길 것이 생긴다.
  cli("tab", "send", "--tab", "인계", "--text", "a.txt 파일에 '사과' 라고 써라. 다른 건 하지 마라.");
  await settle("첫 턴");
  console.log("첫 턴 끝");

  // 본론: Codex 로 넘기면서 떠나는 Claude 에게 인계서를 쓰게 한다.
  const t0 = Date.now();
  const cfg = await ev((id) => window.workbench.chat.switchProvider(id, { provider: "codex", preserveContext: true, askSummary: true }), tabId);
  console.log(`전환 완료 (${Math.round((Date.now() - t0) / 1000)}s) provider=${cfg.provider} handoffPending=${cfg.handoffPending}`);

  // 인계서는 다음 메시지에 실릴 때까지 디스크에 있다.
  const file = path.join(E2E, "userdata", "threads", `${tabId}.handoff.txt`);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  console.log("인계서 길이:", text.length);
  console.log("인계서 앞부분:", JSON.stringify(text.slice(0, 200)));

  // 우리가 만든 기계 요약은 이 머리말로 시작한다 — 그게 아니어야 모델이 쓴 것이다.
  const mechanical = text.startsWith("## 이전 세션 요약");
  console.log("RESULT (Codex 로 전환됨):", cfg.provider === "codex" ? "PASS" : "FAIL");
  console.log("RESULT (넘길 인계서가 대기 중):", cfg.handoffPending === true ? "PASS" : "FAIL");
  console.log("RESULT (디스크에 남았다 — 껐다 켜도 산다):", text.length > 50 ? "PASS" : "FAIL");
  console.log("RESULT (모델이 쓴 인계서다):", !mechanical && text.length > 50 ? "PASS" : "FAIL");
  console.log("RESULT (원래 요청이 담겼다):", /사과|a\.txt/.test(text) ? "PASS" : "FAIL");

  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
