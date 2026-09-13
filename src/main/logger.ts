// main 콘솔 → userData/logs/main.log 파일. 크래시 후 원인을 볼 수 있게 남기는 용도.
// 크기 기준 회전(main.log → main.1.log → …), 최대 MAX_FILES 개 보관.

import fs from "node:fs";
import path from "node:path";
import { inspect } from "node:util";

export const LOG_FILE = "main.log";
const MAX_BYTES = 5 * 1024 * 1024;
const MAX_FILES = 3;

type Level = "info" | "warn" | "error";

export interface FileLogger {
  readonly dir: string;
  readonly file: string;
  write(level: Level, args: unknown[]): void;
  /** console.log/warn/error 를 가로채 파일에도 쓴다. 원래 콘솔 출력은 유지. */
  patchConsole(): void;
}

function formatArg(a: unknown): string {
  if (typeof a === "string") return a;
  if (a instanceof Error) return a.stack || `${a.name}: ${a.message}`;
  return inspect(a, { depth: 4, breakLength: Infinity });
}

export function formatLine(level: Level, args: unknown[], now = new Date()): string {
  const tag = level.toUpperCase().padEnd(5);
  return `${now.toISOString()} ${tag} ${args.map(formatArg).join(" ")}\n`;
}

/** main.log 가 maxBytes 를 넘으면 main.1.log … 로 밀고 가장 오래된 것을 지운다. */
export function rotateIfNeeded(dir: string, maxBytes = MAX_BYTES, maxFiles = MAX_FILES): boolean {
  const current = path.join(dir, LOG_FILE);
  let size = 0;
  try {
    size = fs.statSync(current).size;
  } catch {
    return false;
  }
  if (size < maxBytes) return false;

  const base = LOG_FILE.replace(/\.log$/, "");
  const rotated = (n: number) => path.join(dir, `${base}.${n}.log`);
  try {
    fs.rmSync(rotated(maxFiles - 1), { force: true });
  } catch {}
  for (let n = maxFiles - 2; n >= 1; n--) {
    try {
      fs.renameSync(rotated(n), rotated(n + 1));
    } catch {}
  }
  try {
    fs.renameSync(current, rotated(1));
  } catch {}
  return true;
}

export function createFileLogger(dir: string, opts: { maxBytes?: number; maxFiles?: number } = {}): FileLogger {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, LOG_FILE);
  let written = 0;
  try {
    written = fs.statSync(file).size;
  } catch {}

  const write = (level: Level, args: unknown[]) => {
    const line = formatLine(level, args);
    try {
      if (written + line.length >= (opts.maxBytes ?? MAX_BYTES)) {
        rotateIfNeeded(dir, 0, opts.maxFiles ?? MAX_FILES);
        written = 0;
      }
      fs.appendFileSync(file, line, "utf8");
      written += Buffer.byteLength(line);
    } catch {
      // 로그를 못 써도 앱은 계속 돈다.
    }
  };

  return {
    dir,
    file,
    write,
    patchConsole() {
      const orig = { log: console.log, warn: console.warn, error: console.error };
      console.log = (...args: unknown[]) => {
        orig.log(...args);
        write("info", args);
      };
      console.warn = (...args: unknown[]) => {
        orig.warn(...args);
        write("warn", args);
      };
      console.error = (...args: unknown[]) => {
        orig.error(...args);
        write("error", args);
      };
    },
  };
}
