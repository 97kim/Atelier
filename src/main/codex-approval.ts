// Codex TUI 의 승인 프롬프트를 pty 출력에서 알아낸다. Codex 는 Claude 처럼 실행 단위로 훅을 주입할 길이 없어(~/.codex/hooks.json + trust 필요)
// 화면에 찍히는 문구로 판단한다. codex-cli 0.153 실기기 화면: "Would you like to run the following command? … $ <명령> › 1. Yes, proceed (y)";
// 바이너리에서 확인한 다른 변형: "Allow Codex to run `…`", "Codex wants to edit …", "grant these permissions",
// MCP 도구 승인의 "Allow this request and continue" / "Run the tool and continue", 답한 뒤의 "Approved action:".
import type { TerminalAttention } from "./session-manager";
import { mt } from "./i18n";

export type CodexApprovalSignal = { kind: "prompt"; attention: TerminalAttention } | { kind: "answered" };

/** CSI·OSC 등 ANSI 시퀀스와 제어 문자를 지운다(TUI 는 색·커서 이동으로 문장을 잘게 쪼개 그린다). */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-9;?<>=!]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-9A-Za-z]/g, "")
    .replace(/\x1b[=>78]/g, "")
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
}

/** 공백 정리 + TUI 박스 문자(│╭╮╰╯─ 등) 제거. */
const collapse = (s: string) => s.replace(/[\u2500-\u257f]/g, " ").replace(/\s+/g, " ").trim();

/** 프롬프트가 들어 있을 때만 정규식을 돌리는 값싼 관문. 모델이 찍는 출력이 입력이므로 스캔 비용을 여기서 막는다. */
const GATE = ["Yes, proceed", "Allow Codex to run", "Codex wants to edit", "grant these permissions", "Allow this request and continue", "Run the tool and continue", "Approved action:"];

/**
 * 선택지 "1. Yes, proceed" 바로 앞의 "$ <명령>" 을 뽑는다 — 정규식 백트래킹 없이 indexOf 로만(모델이 `$` 뒤에 공백을 잔뜩 찍어도 선형).
 * 선택지 앞 800자 안에서 마지막 "$ " 를 찾고, 그 뒤부터 선택지 표식(›) 전까지를 명령으로 본다.
 */
function commandBeforeChoice(text: string): { at: number; command: string } | null {
  let best: { at: number; command: string } | null = null;
  let from = 0;
  for (;;) {
    const choice = text.indexOf("1. Yes, proceed", from);
    if (choice === -1) break;
    from = choice + 1;
    const windowStart = Math.max(0, choice - 800);
    const window = text.slice(windowStart, choice);
    const dollar = window.lastIndexOf("$ ");
    if (dollar === -1) continue;
    const command = collapse(window.slice(dollar + 2).replace(/›\s*$/, "").replace(/›/g, " "));
    if (!command || command.length > 600) continue;
    best = { at: windowStart + dollar, command };
  }
  return best;
}

/** 정리된 텍스트에서 승인 프롬프트(또는 답함)를 찾는다. 가장 뒤에 나온 것을 고른다 — 최신 화면이 진실이다. */
export function detectCodexApproval(raw: string, now = Date.now()): CodexApprovalSignal | null {
  if (!GATE.some((g) => raw.includes(g))) return null;
  // TUI 는 박스 문자(│)로 줄을 감싸므로 문장 사이에 끼어든다 — 먼저 공백으로 바꿔야 "sandbox? │ $ cmd" 가 이어진다.
  const text = raw.replace(/[\u2500-\u257f]/g, " ");
  const found: { at: number; signal: CodexApprovalSignal }[] = [];
  const push = (at: number, signal: CodexApprovalSignal) => at >= 0 && found.push({ at, signal });
  const attention = (tool: string, summary: string): CodexApprovalSignal => ({
    kind: "prompt",
    attention: { kind: "permission", tool, summary: summary.slice(0, 200), since: now },
  });
  // codex-cli 0.153 실제 화면: "Would you like to run the following command? … Reason: <모델이 쓴 문장> $ <명령> › 1. Yes, proceed (y) …"
  const cmd = commandBeforeChoice(text);
  if (cmd) push(cmd.at, attention(mt("session.attention.runCommand"), cmd.command));
  for (const m of text.matchAll(/Allow Codex to run `([^`\n]{0,600})`/g)) push(m.index ?? -1, attention(mt("session.attention.runCommand"), collapse(m[1])));
  for (const m of text.matchAll(/Codex wants to edit ([^\n]{0,300})/g)) push(m.index ?? -1, attention(mt("session.attention.editFile"), collapse(m[1]).replace(/[?:]+$/, "")));
  for (const m of text.matchAll(/grant these permissions/g)) push(m.index ?? -1, attention(mt("session.attention.permissionRequest"), ""));
  for (const m of text.matchAll(/Allow this request and continue|Run the tool and continue/g)) push(m.index ?? -1, attention(mt("session.attention.runTool"), ""));
  for (const m of text.matchAll(/Approved action:/g)) push(m.index ?? -1, { kind: "answered" });
  // 폴백: 위 문구가 바뀌어도 승인 선택지 틀("Yes, proceed (y)" 뒤에 "Press enter to confirm or esc to cancel")은 잡는다.
  if (found.length === 0) {
    const yes = text.indexOf("Yes, proceed (y)");
    if (yes >= 0 && text.slice(yes, yes + 500).includes("Press enter to confirm or esc to cancel")) push(yes, attention(mt("session.attention.approvalRequest"), ""));
  }
  if (found.length === 0) return null;
  found.sort((a, b) => a.at - b.at);
  return found[found.length - 1].signal;
}

/** 원시(이스케이프 포함) 버퍼 상한. ANSI 는 매칭 직전에 통째로 벗긴다 — 청크 경계에서 잘린 이스케이프가 남지 않게. */
const BUFFER_MAX = 24000;

/**
 * pty 청크를 원시 그대로 이어 붙이고(문장·이스케이프가 청크 경계에서 잘려도 잡히게) 매칭 때 ANSI 를 벗겨 감지한다.
 * 신호를 찾으면 버퍼를 비워 같은 프롬프트를 다시 보고하지 않는다.
 */
export class CodexApprovalDetector {
  private buffer = "";

  push(chunk: string, now = Date.now()): CodexApprovalSignal | null {
    this.buffer = (this.buffer + chunk).slice(-BUFFER_MAX);
    const signal = detectCodexApproval(stripAnsi(this.buffer), now);
    if (signal) this.buffer = "";
    return signal;
  }

  reset(): void {
    this.buffer = "";
  }
}
