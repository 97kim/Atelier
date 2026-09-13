// 앱이 띄울 수 있는 언어 서버 명세. 서버마다 실행 파일·인자·담당 확장자를 두고, main 은 id 로 프로세스를 관리하고
// 렌더러는 파일 확장자로 어느 서버에 붙을지 정한다. 새 언어는 여기 항목 하나로 늘린다.

export type LspServerId = "typescript" | "python";

export interface LspServerSpec {
  id: LspServerId;
  label: string;
  /** PATH 에서 찾을 실행 파일 이름. */
  bin: string;
  args: string[];
  /** 설치 안내(설정 카드에 그대로 보인다). */
  hint: string;
  /** 확장자(소문자, 점 없음) → LSP languageId. */
  languages: Record<string, string>;
}

export const LSP_SERVERS: readonly LspServerSpec[] = [
  {
    id: "typescript",
    label: "TypeScript / JavaScript",
    bin: "typescript-language-server",
    args: ["--stdio"],
    hint: "npm i -g typescript-language-server typescript",
    languages: {
      ts: "typescript",
      mts: "typescript",
      cts: "typescript",
      tsx: "typescriptreact",
      js: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      jsx: "javascriptreact",
    },
  },
  {
    id: "python",
    label: "Python",
    bin: "pyright-langserver",
    args: ["--stdio"],
    hint: "npm i -g pyright",
    languages: { py: "python", pyi: "python" },
  },
];

export function lspServerSpec(id: string): LspServerSpec | null {
  return LSP_SERVERS.find((s) => s.id === id) ?? null;
}

export function isLspServerId(id: unknown): id is LspServerId {
  return typeof id === "string" && LSP_SERVERS.some((s) => s.id === id);
}

/** 파일 경로 → 담당 서버와 languageId. 담당 서버가 없으면 null(문법 하이라이트만). */
export function lspServerForPath(path: string): { server: LspServerSpec; languageId: string } | null {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  for (const server of LSP_SERVERS) {
    const languageId = server.languages[ext];
    if (languageId) return { server, languageId };
  }
  return null;
}
