#!/usr/bin/env node
// `atelier` — 실행 중인 Atelier 앱을 명령줄에서 제어한다(에이전트용). 의존성 없음: 앱에 동봉된 Electron 을 node 로 돌리거나 시스템 node 로 실행.
// 앱과는 userData 의 유닉스 소켓(control.sock)으로 줄 단위 JSON 을 주고받는다(src/main/control-server.ts).
// 출력은 항상 JSON 한 덩어리(stdout). 실패는 exit 1 + {"error":{...}}.
"use strict";
const net = require("node:net");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

function userDataDir() {
  if (process.env.ATELIER_USERDATA) return process.env.ATELIER_USERDATA;
  const home = os.homedir();
  if (process.platform === "darwin") return path.join(home, "Library", "Application Support", "Atelier");
  if (process.platform === "win32") return path.join(process.env.APPDATA || path.join(home, "AppData", "Roaming"), "Atelier");
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, ".config"), "Atelier");
}

/** 소켓 위치: ATELIER_SOCKET → userData/control.json 의 socket(앱이 시작할 때 쓴다) → userData/control.sock */
function socketPath() {
  if (process.env.ATELIER_SOCKET) return process.env.ATELIER_SOCKET;
  const ud = userDataDir();
  try {
    const info = JSON.parse(fs.readFileSync(path.join(ud, "control.json"), "utf8"));
    if (info && typeof info.socket === "string") return info.socket;
  } catch {
    /* 앱이 안 떠 있거나 옛 버전 */
  }
  return path.join(ud, "control.sock");
}

const USAGE = `atelier — 실행 중인 Atelier 를 제어한다. 출력은 항상 JSON.

  atelier status
  atelier ws list
  atelier ws add --path /abs/dir
  atelier tab list [--ws <id|name>] [--all]
  atelier tab new [--ws <id|name>] [--cwd /abs/dir] [--provider claude|codex] [--policy ask|auto_edit|full]
                  [--model <id>] [--title <text>] [--prompt <text>] [--activate]
  atelier tab status --tab <sel>
  atelier tab send --tab <sel> --text <text> [--wait] [--timeout-ms N]
  atelier tab wait --tab <sel> [--timeout-ms N]
  atelier tab read --tab <sel> [--last N]
  atelier tab activate --tab <sel>
  atelier tab close --tab <sel>
  atelier tab abort --tab <sel>
  atelier tab verify --tab <sel> [--cmd <명령>]... [--wait] [--timeout-ms N]   # 저장한 검증 명령(또는 --cmd) 실행 → 카드
  atelier tab verify-abort --tab <sel>
  atelier tab fanout --tab <sel> --prompt <text> --provider claude --provider codex [--policy ask|auto_edit|full] [--wait] [--timeout-ms N]
                                       # 지시 하나를 격리 세션(worktree) N개에 동시에 → 원래 탭에 팬아웃 카드
  atelier file open --path /abs/file [--line N] [--tab <sel>]
  atelier browser open --url https://… [--tab <sel>]
  atelier browser read [--tab <sel>]                     보이는 글과 누를 만한 것(선택자 포함)
  atelier browser click (--selector <css> | --text <글>) [--tab <sel>]
  atelier browser fill --selector <css> --value <값> [--tab <sel>]
  atelier orch run-create --objective <text> [--coordinator active|<tab>]   # 오케스트레이션 Run (코디네이터 = 사람 또는 탭)
  atelier orch worker-start --run <id> [--key <k>] (--spec <text> | --task <id>) [--agent claude|codex] [--model <id>]
                            [--policy ask|auto_edit|full] [--cwd /abs] [--worktree] [--request-id <id>]
  atelier orch check --run <id> [--key <k>] [--wait] [--types worker_done,question,escalation,note] [--ack <delivery>] [--peek] [--timeout-ms N]
  atelier orch reply --run <id> [--key <k>] --id <question> --body <text>
  atelier orch send --run <id> ... --type followup --to dispatch:<id>|@all|@claude|@codex|@idle --body <text>   # 코디네이터 → 워커(그룹 가능)
  atelier orch send --run <id> --dispatch <id> --capability <c> --type worker_done|escalation ...   # 워커 → 코디네이터
  atelier orch ask --run <id> --dispatch <id> --capability <c> (--question <text> [--options a,b] | --resume <msg>) [--timeout-ms N]
  atelier orch task-create --run <id> --key <k> --spec <text> [--deps <task>,<task>]     # DAG: 의존 Task 가 succeeded 여야 시작 가능
  atelier orch task-list --run <id> [--ready]                                            # --ready: 지금 시작할 수 있는 것만
  atelier orch gate-create --run <id> --key <k> --task <id> --question <text> --options a,b   # 시작 전 결정(코디네이터 소유)
  atelier orch gate-resolve --run <id> --key <k> --id <gate> --resolution <choice> | gate-list --run <id> [--task <id>]
  atelier orch worker-start ... [--terminal <tab>]     # 정산된 워커의 탭 재사용(같은 provider·경로)
  atelier orch worker-cleanup --run <id> --key <k> --dispatch <id>   # 정산된 워커의 탭 닫기 + worktree 삭제(강제)
  atelier orch run-list | run-show --run <id> | run-close --run <id>
  atelier orch worker-list --run <id> | worker-show|worker-retain|worker-release|worker-stop|worker-abandon --run <id> --dispatch <id>
  atelier skills get [atelier-cli]      # 이 앱 버전의 에이전트용 가이드(마크다운)
  atelier skills install                # Claude Code(~/.claude/skills)·Codex(~/.codex/skills) 에 스킬 스텁 설치

  <sel> = active | 탭 id | 정확한 제목 | 유일한 제목 접두
  --text / --prompt 에 "-" 를 주면 stdin 에서 읽는다.
`;

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      pos.push(...argv.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const key = (eq >= 0 ? a.slice(2, eq) : a.slice(2)).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      let val;
      if (eq >= 0) val = a.slice(eq + 1);
      else if (i + 1 < argv.length && !argv[i + 1].startsWith("--")) val = argv[++i];
      else val = true;
      // 같은 플래그를 반복하면(--cmd a --cmd b) 배열로 모은다
      if (key in flags) flags[key] = (Array.isArray(flags[key]) ? flags[key] : [flags[key]]).concat([val]);
      else flags[key] = val;
    } else pos.push(a);
  }
  return { pos, flags };
}

/** 값이 있어야 하는 플래그. `--tab` 처럼 값 없이 쓰면 서버가 active 로 오해하기 전에 여기서 거절한다. */
const VALUE_FLAGS = ["tab", "text", "prompt", "ws", "cwd", "provider", "policy", "model", "title", "path", "url", "line", "last", "timeoutMs", "cmd", "run", "key", "spec", "task", "agent", "dispatch", "capability", "question", "options", "resume", "id", "body", "subject", "type", "to", "outcome", "filesModified", "types", "ack", "objective", "coordinator", "reason", "requestId", "deps", "terminal", "resolution"];
function checkValueFlags(flags) {
  for (const k of VALUE_FLAGS) if (flags[k] === true || (Array.isArray(flags[k]) && flags[k].includes(true))) fail(`--${k.replace(/([A-Z])/g, (m) => "-" + m.toLowerCase())} 에는 값이 필요합니다.`, "bad_request");
}

function readStdinIfDash(v) {
  if (v !== "-") return v;
  return fs.readFileSync(0, "utf8").replace(/\n$/, "");
}

/**
 * 요청 하나를 보내고 응답 한 줄을 기다린다. 응답 전에 연결이 끊기면(앱 종료 중 등) 실패로, 응답이 영영 안 오면 데드라인(서버 대기 시간 + 여유)으로 끝낸다.
 */
function request(method, params, deadlineMs) {
  return new Promise((resolve, reject) => {
    const sock = net.createConnection(socketPath());
    let buf = "";
    let settled = false;
    const finish = (fn, v) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      fn(v);
    };
    const timer = setTimeout(() => finish(reject, Object.assign(new Error(`응답이 ${Math.round(deadlineMs / 1000)}초 안에 오지 않았습니다.`), { code: "timeout" })), deadlineMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(JSON.stringify({ id: 1, method, params }) + "\n"));
    sock.on("data", (d) => {
      buf += d;
      const i = buf.indexOf("\n");
      if (i < 0) return;
      const line = buf.slice(0, i);
      try {
        finish(resolve, JSON.parse(line));
      } catch {
        finish(reject, new Error("응답을 읽지 못했습니다: " + line.slice(0, 200)));
      }
    });
    sock.on("end", () => finish(reject, Object.assign(new Error("응답 전에 연결이 끊겼습니다(앱이 종료 중일 수 있습니다)."), { code: "disconnected" })));
    sock.on("close", () => finish(reject, Object.assign(new Error("응답 전에 연결이 끊겼습니다(앱이 종료 중일 수 있습니다)."), { code: "disconnected" })));
    sock.on("error", (e) => {
      if (e.code === "ENOENT" || e.code === "ECONNREFUSED") finish(reject, Object.assign(new Error("Atelier 가 실행 중이 아닙니다(제어 소켓 없음). 앱을 먼저 여세요."), { code: "not_running" }));
      else finish(reject, e);
    });
  });
}

function out(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + "\n");
}
function fail(message, code = "error", extra = {}) {
  process.stdout.write(JSON.stringify({ error: { code, message, ...extra } }, null, 2) + "\n");
  process.exit(1);
}

const SKILL_STUB = path.join(__dirname, "skill-stub.md");
const SKILL_GUIDE = path.join(__dirname, "skill-guide.md");

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  if (flags.help || flags.h || pos.length === 0) {
    process.stdout.write(USAGE);
    return;
  }
  if (flags.version) {
    out({ cli: readVersion() });
    return;
  }
  const [group, cmd] = pos;
  checkValueFlags(flags);
  const timeoutMs = flags.timeoutMs !== undefined ? Number(flags.timeoutMs) : undefined;

  // 앱이 없어도 되는 명령
  if (group === "skills") {
    if (cmd === "get") {
      const name = pos[2] || "atelier-cli";
      if (name !== "atelier-cli") return fail(`모르는 가이드: ${name}`, "not_found");
      process.stdout.write(fs.readFileSync(SKILL_GUIDE, "utf8"));
      return;
    }
    if (cmd === "install") {
      // 이 PC 에 있는 에이전트마다: Claude Code(~/.claude/skills), Codex CLI($CODEX_HOME/skills, 기본 ~/.codex/skills)
      const home = os.homedir();
      const targets = [
        { label: "Claude Code", home: path.join(home, ".claude"), dir: path.join(home, ".claude", "skills", "atelier-cli") },
        { label: "Codex CLI", home: process.env.CODEX_HOME || path.join(home, ".codex"), dir: path.join(process.env.CODEX_HOME || path.join(home, ".codex"), "skills", "atelier-cli") },
      ];
      const stub = fs.readFileSync(SKILL_STUB, "utf8");
      const installed = [];
      const skipped = [];
      for (const t of targets) {
        if (!fs.existsSync(t.home)) { skipped.push(t.label); continue; }
        fs.mkdirSync(t.dir, { recursive: true });
        fs.writeFileSync(path.join(t.dir, "SKILL.md"), stub);
        installed.push(path.join(t.dir, "SKILL.md"));
      }
      if (installed.length === 0) return fail("Claude Code(~/.claude)도 Codex(~/.codex)도 이 PC 에 없습니다.", "not_found");
      out({ installed, skipped, note: "새 세션부터 스킬이 보입니다(Claude Code: /atelier-cli, Codex: $atelier-cli)." });
      return;
    }
    return fail(`skills ${cmd ?? ""}: 모르는 명령. 'get' 또는 'install'.`);
  }

  // orch ask: 질문을 먼저 만들어 message_id 를 확보한 뒤 기다린다 — 대기 중 연결이 끊겨도 --resume 할 id 를 알 수 있게.
  // 같은 질문을 다시 실행하면(재시도) requestId(질문 본문의 해시)로 중복 생성을 막는다.
  if (group === "orch" && cmd === "ask" && flags.resume === undefined) {
    const question = flags.question !== undefined ? readStdinIfDash(String(flags.question)) : undefined;
    if (!question) return fail("--question 이 필요합니다.", "bad_request");
    const requestId = flags.requestId ?? require("crypto").createHash("sha1").update(String(flags.dispatch) + "\n" + question).digest("hex").slice(0, 16);
    const base = { run: flags.run, dispatch: flags.dispatch, capability: flags.capability, requestId };
    let created;
    try {
      created = await request("orch.ask", { ...base, question, options: flags.options, wait: false }, 30000);
    } catch (e) {
      return fail(e.message, e.code || "transport");
    }
    if (created.error) return fail(created.error.message, created.error.code || "error");
    if (created.result.state === "answered") return out(created.result);
    const messageId = created.result.messageId;
    try {
      const waited = await request("orch.ask", { ...base, resume: messageId, timeoutMs }, (timeoutMs ?? 600000) + 15000);
      if (waited.error) return fail(`${waited.error.message} (질문 id ${messageId} — --resume ${messageId} 로 다시 기다리세요)`, waited.error.code || "error");
      return out(waited.result);
    } catch (e) {
      return fail(`${e.message} (질문은 남아 있습니다 — --resume ${messageId} 로 다시 기다리세요)`, e.code || "transport");
    }
  }

  let method;
  let params = {};
  if (group === "status" && !cmd) method = "status";
  else if (group === "ws" && cmd === "list") method = "ws.list";
  else if (group === "ws" && cmd === "add") { method = "ws.add"; params = { path: flags.path }; }
  else if (group === "tab" && cmd === "list") { method = "tab.list"; params = { workspace: flags.ws, all: flags.all === true }; }
  else if (group === "tab" && cmd === "new") {
    method = "tab.new";
    params = { workspace: flags.ws, cwd: flags.cwd, provider: flags.provider, policy: flags.policy, model: flags.model, title: flags.title, prompt: flags.prompt !== undefined ? readStdinIfDash(String(flags.prompt)) : undefined, activate: flags.activate === true };
  } else if (group === "tab" && cmd === "status") { method = "tab.status"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "send") {
    method = "tab.send";
    params = { tab: flags.tab, text: flags.text !== undefined ? readStdinIfDash(String(flags.text)) : undefined, wait: flags.wait === true, timeoutMs };
  } else if (group === "tab" && cmd === "wait") { method = "tab.wait"; params = { tab: flags.tab, timeoutMs }; }
  else if (group === "tab" && cmd === "read") { method = "tab.read"; params = { tab: flags.tab, last: flags.last !== undefined ? Number(flags.last) : undefined }; }
  else if (group === "tab" && cmd === "activate") { method = "tab.activate"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "close") { method = "tab.close"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "abort") { method = "tab.abort"; params = { tab: flags.tab }; }
  else if (group === "tab" && cmd === "verify") {
    method = "tab.verify";
    const cmds = flags.cmd === undefined ? undefined : (Array.isArray(flags.cmd) ? flags.cmd : [flags.cmd]).map(String);
    params = { tab: flags.tab, commands: cmds, wait: flags.wait === true, timeoutMs };
  } else if (group === "tab" && cmd === "verify-abort") { method = "tab.verify.abort"; params = { tab: flags.tab }; }
  else if (group === "orch" && cmd) {
    method = "orch." + cmd;
    const f = flags;
    params = {
      run: f.run, key: f.key, objective: f.objective, coordinator: f.coordinator, spec: f.spec !== undefined ? readStdinIfDash(String(f.spec)) : undefined, task: f.task,
      agent: f.agent, model: f.model, policy: f.policy, cwd: f.cwd, worktree: f.worktree === true, requestId: f.requestId,
      dispatch: f.dispatch, capability: f.capability, type: f.type, to: f.to, subject: f.subject, body: f.body !== undefined ? readStdinIfDash(String(f.body)) : undefined,
      outcome: f.outcome, filesModified: f.filesModified, question: f.question, options: f.options, resume: f.resume, id: f.id, reason: f.reason,
      wait: f.wait === true, peek: f.peek === true, types: f.types, ack: f.ack, timeoutMs,
      deps: f.deps, ready: f.ready === true, terminal: f.terminal, resolution: f.resolution,
    };
  }
  else if (group === "tab" && cmd === "fanout") {
    method = "tab.fanout";
    const providers = flags.provider === undefined ? undefined : (Array.isArray(flags.provider) ? flags.provider : [flags.provider]).map(String);
    params = { tab: flags.tab, prompt: flags.prompt !== undefined ? readStdinIfDash(String(flags.prompt)) : undefined, providers, policy: flags.policy, wait: flags.wait === true, timeoutMs };
  }
  else if (group === "file" && cmd === "open") { method = "file.open"; params = { tab: flags.tab, path: flags.path, line: flags.line !== undefined ? Number(flags.line) : undefined }; }
  else if (group === "browser" && cmd === "open") { method = "browser.open"; params = { tab: flags.tab, url: flags.url }; }
  else if (group === "browser" && cmd === "read") { method = "browser.read"; params = { tab: flags.tab }; }
  else if (group === "browser" && cmd === "click") { method = "browser.click"; params = { tab: flags.tab, selector: flags.selector, text: flags.text }; }
  else if (group === "browser" && cmd === "fill") { method = "browser.fill"; params = { tab: flags.tab, selector: flags.selector, value: flags.value }; }
  else return fail(`모르는 명령: ${[group, cmd].filter(Boolean).join(" ")}. --help 를 보세요.`, "unknown_command");

  for (const k of Object.keys(params)) if (params[k] === undefined) delete params[k];
  // --tab 을 안 주면 서버가 active 로 본다(선택자 규칙은 서버에)
  // 데드라인: 기다리는 명령은 서버 대기 시간(기본 10분) + 15초, 나머지는 30초
  const waits = method === "tab.wait" || method === "orch.ask" || ((method === "tab.send" || method === "tab.verify" || method === "tab.fanout" || method === "orch.check") && params.wait);
  const deadline = waits ? (timeoutMs ?? (method === "tab.verify" || method === "tab.fanout" ? 1800000 : method === "orch.check" ? 900000 : 600000)) + 15000 : 30000;
  let res;
  try {
    res = await request(method, params, deadline);
  } catch (e) {
    return fail(e.message, e.code || "transport");
  }
  if (res.error) return fail(res.error.message, res.error.code || "error");
  out(res.result);
}

function readVersion() {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "version.json"), "utf8")).version;
  } catch {
    return "dev";
  }
}

main().catch((e) => fail(e.message));
