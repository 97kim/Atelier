// 예약 실행. 정해진 시각에 스스로 깨어나 돌고, 끝을 정확히 판정하고, 이력에 남는가.
// 손으로 확인한 흐름(45초 running → 55초 completed)을 그대로 고정한다.
const path = require("path"), fs = require("fs"), { execFileSync } = require("child_process");
const E2E = __dirname;
const app = path.join(__dirname, "..", "release/mac-arm64/Atelier.app");
const cli = (...a) => JSON.parse(execFileSync(app + "/Contents/MacOS/Atelier", [app + "/Contents/Resources/cli/atelier.cjs", ...a], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", ATELIER_USERDATA: E2E + "/userdata" }, encoding: "utf8" }));

let __fails = 0;
const result = (name, ok, note) => { if (!ok) __fails += 1; console.log(`RESULT (${name}):`, ok ? "PASS" : `FAIL${note ? " " + note : ""}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // 지난 시험이 남긴 예약을 치운다 — 매분 도는 예약이 쌓이면 다음 시험을 방해한다.
  for (const s of cli("schedule", "list").schedules) cli("schedule", "rm", "--id", s.id);

  const ws = cli("ws", "add", "--path", E2E + "/repo").workspaceId;
  const add = cli("schedule", "add", "--name", "e2e예약", "--cron", "*/1 * * * *",
    "--prompt", "'예약됨' 한 마디만 답해라. 도구는 쓰지 마라.", "--ws", ws, "--policy", "full");
  const id = add.schedule.id;
  result("예약이 만들어진다", Boolean(id));

  const listed = cli("schedule", "list").schedules.find((s) => s.id === id);
  console.log("다음 실행까지", Math.round(((listed?.nextRunAt ?? 0) - Date.now()) / 1000), "초");
  result("다음 실행 시각이 계산된다", typeof listed?.nextRunAt === "number" && listed.nextRunAt > Date.now());

  // 예정 시각까지 기다린다(최대 2분)
  let runs = [];
  let sawRunning = false;
  for (let i = 0; i < 48; i += 1) {
    await sleep(2500);
    runs = cli("schedule", "runs", "--id", id).runs;
    if (runs[0]?.status === "running") sawRunning = true;
    if (runs[0] && ["completed", "failed", "interrupted"].includes(runs[0].status)) break;
  }
  const run = runs[0];
  console.log("회차:", JSON.stringify(run));
  result("예정 시각에 스스로 돈다", Boolean(run), "회차가 만들어지지 않았다");
  result("도는 동안 running 으로 보인다", sawRunning);
  result("끝을 판정한다", run?.status === "completed", `(${run?.status} ${run?.reason ?? ""})`);
  result("어느 세션에서 돌았는지 남는다", Boolean(run?.tabId));

  // 겹침: 방금 끝났으니 다시 돌려도 새 회차가 생긴다(수동)
  const manual = cli("schedule", "run", "--id", id).run;
  result("수동 실행도 된다", ["running", "pending"].includes(manual.status), `(${manual.status})`);
  const dup = cli("schedule", "run", "--id", id).run;
  result("앞 회차가 살아 있으면 겹침으로 건너뛴다", dup.status === "skipped_overlap", `(${dup.status})`);

  // 끄면 돌지 않는다
  cli("schedule", "set", "--id", id, "--enabled", "false");
  const off = cli("schedule", "list").schedules.find((s) => s.id === id);
  result("끄면 꺼진 것으로 보인다", off?.enabled === false);

  cli("schedule", "rm", "--id", id);
  result("지우면 목록에서 사라진다", !cli("schedule", "list").schedules.some((s) => s.id === id));

  // 격리 회차가 정말 worktree 안에서 도는가. 위의 프롬프트는 도구를 금지해서 이걸 못 본다 —
  // 실제로 configure 가 작업 경로를 워크스페이스 경로로 덮어써 격리가 풀린 적이 있다. 파일을 만들게 해서 확인한다.
  const mark = `cwd-check-${Date.now()}.txt`;
  const isoId = cli("schedule", "add", "--name", "e2e격리", "--cron", "0 0 1 1 *",
    "--prompt", `지금 작업 폴더에 ${mark} 라는 빈 파일을 만들어라. 다른 말은 하지 마라.`,
    "--ws", ws, "--policy", "full", "--worktree").schedule.id;
  let iso = cli("schedule", "run", "--id", isoId).run;
  for (let i = 0; i < 60; i += 1) {
    await sleep(2500);
    iso = cli("schedule", "runs", "--id", isoId).runs[0];
    if (iso && ["completed", "failed", "interrupted"].includes(iso.status)) break;
  }
  result("격리 회차가 끝난다", iso?.status === "completed", `(${iso?.status} ${iso?.reason ?? ""})`);
  const isoCwd = iso?.tabId ? cli("tab", "status", "--tab", iso.tabId).tab.cwd : null;
  console.log("격리 작업 경로:", isoCwd);
  result("격리 회차는 원본 저장소에서 돌지 않는다", Boolean(isoCwd) && path.resolve(isoCwd) !== path.resolve(E2E, "repo"));
  result("작업 결과가 worktree 안에 남는다", Boolean(isoCwd) && fs.existsSync(path.join(isoCwd, mark)));
  result("원본 저장소는 건드리지 않는다", !fs.existsSync(path.join(E2E, "repo", mark)));

  // 치운다 — 탭을 닫아도 worktree 는 남는다.
  if (iso?.tabId) try { cli("tab", "close", "--tab", iso.tabId); } catch { /* 이미 닫힘 */ }
  if (isoCwd) try { execFileSync("git", ["worktree", "remove", "--force", isoCwd], { cwd: path.join(E2E, "repo") }); } catch { /* 이미 없음 */ }
  cli("schedule", "rm", "--id", isoId);

  process.exit(__fails ? 1 : 0);
})().catch((e) => { console.error("ERROR", e); process.exit(1); });
