// 자동 스크롤의 세 가지 규칙을 한 번에 본다.
//  (1) 글이 흐르는 동안 맨 아래를 따라간다 — 사람이 손대지 않았는데 풀리면 안 된다
//  (2) 사람이 위로 올려 읽으면 끌어내리지 않는다
//  (3) 메시지를 보내면 맨 아래로 간다 (자기 메시지는 보여야 하니 예외)
//
// (1) 이 깨졌던 이유: "바닥에서 멀면 사용자가 올린 것" 으로 판단했는데, 글이 흐르는 중에는
// 맨 아래로 맞춘 직후에 높이가 또 자라서 그 간격이 사용자 행동으로 읽혔다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Atelier.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Atelier", [app + "/Contents/Resources/cli/atelier.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ATELIER_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

const LONG = "1부터 150까지를 마크다운 목록으로 출력해라. 각 줄은 정확히 `- N` 형식이고 다른 말은 하지 마라.";

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);

  const ws = cli("ws", "add", "--path", E2E + "/repo");
  cli("tab", "new", "--ws", ws.workspaceId, "--provider", "claude", "--title", "스크롤" + Date.now(), "--activate");
  await page.waitForTimeout(2500);
  const tabId = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));

  const m = () => ev(() => {
    const el = document.querySelector("[data-message-list]");
    return { gap: Math.round(el.scrollHeight - el.scrollTop - el.clientHeight), pill: !!document.querySelector("[data-scroll-bottom]"), sh: el.scrollHeight, st: Math.round(el.scrollTop) };
  });
  const statusOf = () => ev((id) => window.workbench.chat.snapshot(id).status, tabId).catch(() => "?");
  const settle = async () => { for (let i = 0; i < 180; i++) { if ((await statusOf()) === "idle") return; await page.waitForTimeout(1000); } };

  // (1) 흐르는 동안 따라가는가
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  const during = [];
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(500);
    during.push(await m());
    if ((await statusOf()) === "idle" && i > 4) break;
  }
  const loose = during.filter((x) => x.gap > 80).length;
  console.log("흐르는 동안 표본:", during.length, "· 바닥에서 떨어진 표본:", loose, "· 최대 간격:", Math.max(...during.map((x) => x.gap)));
  console.log("RESULT (흐르는 동안 맨 아래를 따라간다):", loose === 0 ? "PASS" : "FAIL");
  await settle();
  await page.waitForTimeout(800);

  // (2) 사람이 올려 읽으면 그대로 둔다 — 흐르는 도중에 올린다(보내는 것은 맨 아래로 가는 게 맞으니 섞지 않는다)
  cli("tab", "send", "--tab", tabId, "--text", LONG);
  await page.waitForTimeout(2500);
  const mid = await m();
  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = Math.max(0, el.scrollTop - 1200); });
  await page.waitForTimeout(700);
  const justUp = await m();
  console.log("흐르는 중에 올린 직후:", JSON.stringify(justUp));
  const stayed = [];
  for (let i = 0; i < 10; i++) { await page.waitForTimeout(500); stayed.push(await m()); if ((await statusOf()) === "idle" && i > 2) break; }
  const pulled = stayed.filter((x) => x.gap < 200).length;
  console.log("올린 뒤 표본:", stayed.map((x) => x.gap).join(","));
  console.log("RESULT (올려 읽는 중에는 끌어내리지 않는다):", justUp.gap > 300 && pulled === 0 ? "PASS" : `FAIL (끌려 내려간 표본 ${pulled}개)`);

  // (3) 보내면 맨 아래로
  await settle();
  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = Math.max(0, el.scrollTop - 2000); });
  await page.waitForTimeout(500);
  cli("tab", "send", "--tab", tabId, "--text", "고맙다. 한 글자로 답해라.");
  await page.waitForTimeout(2000);
  const afterSend = await m();
  console.log("보낸 직후:", JSON.stringify(afterSend));
  console.log("RESULT (보내면 맨 아래로 간다):", afterSend.gap < 80 ? "PASS" : `FAIL (${afterSend.gap}px 남음)`);

  await settle();
  await page.screenshot({ path: E2E + "/shot-scroll-follow.png" });
  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
