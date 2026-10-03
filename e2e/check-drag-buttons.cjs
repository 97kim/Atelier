// 창 끌기 영역(-webkit-app-region: drag) 안에 놓인 버튼·링크가 끌기에서 빠져 있는지(no-drag).
// 빠져 있지 않으면 클릭이 창 끌기로 먹혀 눌리지 않는다. CDP 로 누르는 클릭은 이 영역을 우회해서 통과하므로
// 클릭으로는 잡히지 않는다 — 계산된 스타일을 직접 본다. 지금 화면에 보이는 것만 본다.
const { chromium } = require("playwright-core");
(async () => {
  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().startsWith("file:") || p.url().includes("localhost"));
  const bad = await page.evaluate(() =>
    [...document.querySelectorAll("button, a, [role=button], [role=menuitem], input, select, textarea")]
      .filter((e) => e.offsetParent !== null && getComputedStyle(e).webkitAppRegion === "drag")
      .map((e) => `${e.tagName.toLowerCase()} "${(e.textContent || e.getAttribute("title") || "").trim().slice(0, 40)}"`),
  );
  for (const x of bad) console.log("  끌기 영역에 남은 요소:", x);
  console.log("RESULT (끌기 영역 안의 버튼은 no-drag):", bad.length === 0 ? "PASS" : "FAIL", bad.length);
  if (bad.length) process.exitCode = 1;
  await b.close();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });
