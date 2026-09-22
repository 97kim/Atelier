// 예약을 화면에서 만들고 고칠 수 있는가. 여태 만들기는 CLI 뿐이라 첫 사용자는 터미널을 열어야 했다.
// 고른 값이 정말 그 cron 으로 저장되는지, 못 도는 예약이 저장되지 않는지까지 본다.
const path = require("path"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Atelier.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Atelier", [app + "/Contents/Resources/cli/atelier.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ATELIER_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));
const { chromium } = require("playwright-core");

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const NAME = "화면에서만든예약";

(async () => {
  for (const s of cli("schedule", "list").schedules) cli("schedule", "rm", "--id", s.id);
  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  cli("tab", "new", "--ws", ws, "--provider", "claude", "--title", "예약폼", "--activate");

  const b = await chromium.connectOverCDP("http://127.0.0.1:9333");
  const page = b.contexts().flatMap((c) => c.pages()).find((p) => p.url().includes("localhost") || p.url().startsWith("file:"));
  const ev = (fn, arg) => page.evaluate(fn, arg);
  await page.waitForTimeout(1500);

  // 설정은 채팅 화면의 "/config" 로 연다. 그 다음 좌측에서 예약으로 간다.
  await page.fill("textarea:not(.xterm-helper-textarea)", "/config");
  await page.waitForTimeout(300);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(200);
  await page.keyboard.press("Enter");
  await page.waitForTimeout(1200);
  await ev(() => [...document.querySelectorAll("button")].find((x) => x.textContent.trim() === "예약")?.click());
  await page.waitForTimeout(600);
  result("예약 화면이 열린다", await ev(() => !!document.querySelector("[data-schedules-section]")));
  // 앱은 시험 사이에 계속 떠 있다. 지난 회차가 폼을 열어 둔 채 끝났으면 닫고 시작한다.
  await ev(() => {
    const form = document.querySelector("[data-schedule-form]");
    if (form) [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "취소")?.click();
  });
  await page.waitForTimeout(400);
  result("화면에 만들기 버튼이 있다", await ev(() => !!document.querySelector("[data-new-schedule]")));

  await page.click("[data-new-schedule]");
  await page.waitForTimeout(300);
  result("폼이 열린다", await ev(() => !!document.querySelector("[data-schedule-form]")));

  // 빈 채로 저장하면 못 도는 예약이 생기면 안 된다.
  await page.click("[data-f-save]");
  await page.waitForTimeout(500);
  const errText = await ev(() => document.querySelector("[data-schedule-error]")?.textContent?.trim() ?? "");
  console.log("오류 문구:", errText);
  result("빈 채로 저장하면 막고 이유를 말한다", errText.length > 0);
  // Electron 이 앞에 붙이는 "Error invoking remote method 'schedules:save'" 배관이 새어 나오면 안 된다.
  result("오류 문구에 내부 배관이 새지 않는다", !/remote method|schedules:save/.test(errText), `(${errText})`);
  result("막힌 예약은 저장되지 않는다", cli("schedule", "list").schedules.length === 0);

  await page.fill("[data-f-name]", NAME);
  await page.selectOption("[data-f-repeat]", "daily");
  await page.selectOption("[data-f-hour]", "07");
  await page.selectOption("[data-f-minute]", "30");
  await page.selectOption("[data-f-ws]", ws);
  await page.fill("[data-f-prompt]", "'예약됨' 한 마디만 답해라.");
  await page.waitForTimeout(300);
  const preview = await ev(() => document.querySelector("[data-f-preview]")?.textContent?.trim() ?? "");
  console.log("미리보기:", preview);
  result("저장 전에 다음 실행 시각을 보여 준다", preview.includes("다음") && !preview.includes("cron 형식이 아닙니다"), `(${preview})`);
  await page.screenshot({ path: E2E + "/shot-schedule-form.png" });

  await page.click("[data-f-save]");
  await page.waitForTimeout(900);
  const made = cli("schedule", "list").schedules.find((s) => s.name === NAME);
  result("화면에서 만든 예약이 저장된다", Boolean(made));
  result("고른 시각이 그 cron 으로 저장된다", made?.cron === "30 7 * * *", `(${made?.cron})`);
  result("다음 실행 시각이 계산된다", typeof made?.nextRunAt === "number" && made.nextRunAt > Date.now());
  result("폼이 닫힌다", await ev(() => !document.querySelector("[data-schedule-form]")));

  // 고치기: 저장된 값을 되읽어 폼을 채우는가.
  await page.click("[data-edit-schedule]");
  await page.waitForTimeout(400);
  const back = await ev(() => ({
    name: document.querySelector("[data-f-name]")?.value ?? null,
    repeat: document.querySelector("[data-f-repeat]")?.value ?? null,
    time: `${document.querySelector("[data-f-hour]")?.value ?? ""}:${document.querySelector("[data-f-minute]")?.value ?? ""}`,
    // 네이티브 time 입력을 걷어냈다 — OS 드롭다운(오전/오후 3열)이 이 화면에서만 혼자 튀었다.
    noNativeTime: !document.querySelector('input[type="time"]'),
  }));
  console.log("되읽은 값:", JSON.stringify(back));
  result("고치기가 저장된 값을 되읽는다", back.name === NAME && back.repeat === "daily" && back.time === "07:30", JSON.stringify(back));
  result("시각도 앱의 고르기로 쓴다(네이티브 피커 없음)", back.noNativeTime);
  await page.selectOption("[data-f-repeat]", "weekdays");
  await page.selectOption("[data-f-hour]", "08");
  await page.selectOption("[data-f-minute]", "05");
  await page.click("[data-f-save]");
  await page.waitForTimeout(900);
  const edited = cli("schedule", "list").schedules.find((s) => s.name === NAME);
  result("고친 값이 저장된다", edited?.cron === "5 8 * * 1-5", `(${edited?.cron})`);
  result("고쳐도 같은 예약이다(복제되지 않는다)", cli("schedule", "list").schedules.filter((s) => s.name === NAME).length === 1);

  // 직접 cron 은 틀리면 저장되지 않는다.
  await page.click("[data-edit-schedule]");
  await page.waitForTimeout(400);
  await page.selectOption("[data-f-repeat]", "custom");
  await page.fill("[data-f-cron]", "매일 아침");
  await page.waitForTimeout(300);
  result("틀린 cron 은 미리보기가 말해 준다", (await ev(() => document.querySelector("[data-f-preview]")?.textContent ?? "")).includes("cron 형식이 아닙니다"));
  await page.click("[data-f-save]");
  await page.waitForTimeout(600);
  result("틀린 cron 은 저장되지 않는다", cli("schedule", "list").schedules.find((s) => s.name === NAME)?.cron === "5 8 * * 1-5");

  // 목록이 쌓였을 때의 모습도 남긴다 — 행 하나만 있을 때는 안 보이는 문제가 있다.
  await ev(() => {
    const form = document.querySelector("[data-schedule-form]");
    if (form) [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "취소")?.click();
  });
  await page.waitForTimeout(400);
  // 폼을 닫았으면 그 폼이 낸 오류도 사라져야 한다. 남으면 가리킬 대상이 없는 지적이 목록 위에 걸린다.
  result("취소하면 폼이 낸 오류도 사라진다", await ev(() => !document.querySelector("[data-schedule-error]")));

  cli("schedule", "add", "--name", "주간 정리", "--cron", "0 9 * * 1", "--prompt", "지난 주 커밋을 한 문단으로 정리해 줘.", "--ws", ws);
  cli("schedule", "add", "--name", "매시 점검", "--cron", "15 * * * *", "--prompt", "빌드가 깨졌는지 확인해 줘.", "--ws", ws, "--worktree", "--policy", "full");
  await page.waitForTimeout(700);
  result("목록에 예약이 쌓인다", (await ev(() => document.querySelectorAll("[data-schedule]").length)) >= 3);
  await page.screenshot({ path: E2E + "/shot-schedules.png" });

  // 이름만으로 만든 워크스페이스에는 기본 경로가 없다. 예전에는 그런 워크스페이스로는 예약을 만들 수
  // 없었다 — 폼은 고를 수 있게 보여 주고 저장할 때서야 막았고, 화면에는 경로를 채울 방법도 없었다.
  // 이제 예약이 제 폴더를 갖는다.
  const bare = await ev(() => window.workbench.workspaces.create("경로없음"));
  const bareId = bare?.workspaceId ?? null;
  result("경로 없는 워크스페이스를 만든다", Boolean(bareId));
  let blocked = "통과";
  try {
    cli("schedule", "add", "--name", "경로없음예약", "--cron", "0 5 * * *", "--prompt", "안녕", "--ws", bareId);
  } catch { blocked = "막힘"; }
  result("폴더를 안 주면 막는다", blocked === "막힘", `(${blocked})`);
  cli("schedule", "add", "--name", "폴더지정예약", "--cron", "0 6 * * *", "--prompt", "안녕", "--ws", bareId, "--cwd", E2E + "/repo");
  const listed = cli("schedule", "list").schedules.find((s) => s.name === "폴더지정예약");
  result("폴더를 주면 경로 없는 워크스페이스에서도 만들어진다", Boolean(listed));
  result("그 예약의 다음 실행 시각이 계산된다", typeof listed?.nextRunAt === "number", `(${listed?.nextRunAt})`);

  // 열어 둔 폼은 닫고 나간다 — 다음 시험이 같은 화면을 이어받는다.
  await ev(() => {
    const form = document.querySelector("[data-schedule-form]");
    if (form) [...form.querySelectorAll("button")].find((b) => b.textContent.trim() === "취소")?.click();
  });
  for (const s of cli("schedule", "list").schedules) cli("schedule", "rm", "--id", s.id);
  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
