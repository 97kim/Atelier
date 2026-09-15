// 스크롤이 있는 대화에서 백그라운드 줄과 "맨 아래로" 알약이 어떻게 보이나. 지금 열려 있는 탭을 그대로 쓴다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Atelier.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Atelier", [app + "/Contents/Resources/cli/atelier.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ATELIER_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  const tab = await ev(() => document.querySelector('[data-tab][data-active="true"]')?.getAttribute("data-tab"));
  console.log("쓰는 탭:", tab);

  cli("tab", "send", "--tab", tab, "--text", "Bash 도구를 run_in_background:true 로 네 번 실행해라. 각각 `sleep 300 && echo 하나`, `sleep 300 && echo 둘`, `sleep 300 && echo 셋`, `sleep 300 && echo 넷`. 기다리지 말고 '시작' 한 마디만.");
  for (let i = 0; i < 150; i++) {
    await page.waitForTimeout(1000);
    const n = await ev(() => Number(document.querySelector("[data-background-jobs]")?.getAttribute("data-background-jobs") ?? 0));
    if (n >= 4) break;
  }
  for (let i = 0; i < 120; i++) { await page.waitForTimeout(1000); const st = await ev((t) => window.workbench.chat.snapshot(t).status, tab); if (st === "idle") break; }
  await page.waitForTimeout(1200);

  const geom = () => ev(() => {
    const r = (e) => (e ? { top: Math.round(e.getBoundingClientRect().top), bottom: Math.round(e.getBoundingClientRect().bottom) } : null);
    const list = document.querySelector("[data-message-list]");
    return {
      pill: r(document.querySelector("[data-scroll-bottom]")),
      bar: r(document.querySelector("[data-background-jobs]")),
      listBottom: r(list)?.bottom,
      n: document.querySelector("[data-background-jobs]")?.getAttribute("data-background-jobs") ?? "0",
    };
  });

  await ev(() => { const el = document.querySelector("[data-message-list]"); el.scrollTop = Math.max(0, el.scrollTop - 1500); });
  await page.waitForTimeout(800);
  console.log("접힘 + 맨아래로:", JSON.stringify(await geom()));
  await page.screenshot({ path: E2E + "/scroll-a-접힘.png" });

  await ev(() => document.querySelector("[data-background-jobs-toggle]")?.click());
  await page.waitForTimeout(700);
  console.log("펼침 + 맨아래로:", JSON.stringify(await geom()));
  await page.screenshot({ path: E2E + "/scroll-b-펼침.png" });

  await b.close();
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
