import { spawn } from "node:child_process";
import { query } from "@anthropic-ai/claude-agent-sdk";
// Codex: app-server model/list
const codex = await new Promise((resolve) => {
  const p = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "ignore"] });
  let buf = ""; const out = [];
  p.stdout.on("data", (d) => { buf += d; let i; while ((i = buf.indexOf("\n")) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); try { out.push(JSON.parse(line)); } catch {} const last = out[out.length - 1]; if (last?.id === 2) { p.kill(); resolve(last); } } });
  p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "probe", title: "probe", version: "0" }, capabilities: { experimentalApi: true } } }) + "\n");
  setTimeout(() => { p.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n"); p.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "model/list", params: {} }) + "\n"); }, 800);
  setTimeout(() => { p.kill(); resolve({ error: "timeout" }); }, 15000);
});
console.log("CODEX", JSON.stringify(codex).slice(0, 1500));
// Claude: SDK supportedModels
const env = { ...process.env }; for (const k of Object.keys(env)) if (/^(CLAUDECODE|CLAUDE_CODE_|CLAUDE_PID)/.test(k)) delete env[k];
async function* noPrompt() { await new Promise(() => {}); }
const q = query({ prompt: noPrompt(), options: { cwd: process.cwd(), env, permissionMode: "default" } });
const t = setTimeout(() => { console.log("CLAUDE timeout"); process.exit(0); }, 20000);
const models = await q.supportedModels();
clearTimeout(t);
console.log("CLAUDE", JSON.stringify(models.map((m) => ({ value: m.value, resolved: m.resolvedModel, name: m.displayName, desc: m.description?.slice(0, 60), effort: m.supportedEffortLevels }))));
q.close?.();
process.exit(0);
