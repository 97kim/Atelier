import { useCallback, useEffect, useState } from "react";
import {
  MAX_CONCURRENT_MAX,
  MAX_CONCURRENT_MIN,
  PROVIDERS,
  SESSION_IDLE_MINUTES_MAX,
  SESSION_IDLE_MINUTES_MIN,
  type AppInfoDto,
  type AppSettingsDto,
  type ManagedWorktreeDto,
  type InstallStatusDto,
  type CliCandidateDto,
  type CliDiagnosticsDto,
  type CliStatusDto,
  type LspStatusDto,
  type McpServerStatusDto,
  type Provider,
  type WarmTarget,
} from "@shared/ipc";
import type { NotifyOnDone } from "@shared/ipc";
import type { ThemeMode } from "@shared/theme";
import { applyThemeMode } from "../theme";
import { Icon } from "../components/Icon";
import { SchedulesSection } from "../components/SchedulesSection";
import { ProviderLogo } from "../components/ProviderLogo";
import { shorten } from "../components/ContextPanel";
import { getLinkOpenMode, setLinkOpenMode, type LinkOpenMode } from "../components/Markdown";
import { useSnippets } from "../hooks/useSnippets";
import { snippetSummary, type SnippetDto } from "@shared/snippets";

export type SettingsSection = "general" | "cli" | "mcp" | "snippets" | "schedules";

const LABEL: Record<Provider, [string, string]> = {
  claude: ["Claude Code", "Anthropic"],
  codex: ["Codex CLI", "OpenAI"],
};

interface ProviderState {
  status: CliStatusDto | null;
  candidates: CliCandidateDto[];
  loading: boolean;
  message: string | null;
}

const initial = (): ProviderState => ({ status: null, candidates: [], loading: true, message: null });

export function SettingsView({
  info,
  workspaces,
  workspacePath,
  section,
  onSection,
}: {
  info: AppInfoDto | null;
  /** 스니펫 범위 표시·선택용 워크스페이스 목록. */
  workspaces: { id: string; name: string }[];
  /** MCP 상태를 조회할 기준 디렉토리(현재 워크스페이스). 없으면 MCP 화면은 안내만. */
  workspacePath: string | null;
  section: SettingsSection;
  onSection: (s: SettingsSection) => void;
}) {
  const [state, setState] = useState<Record<Provider, ProviderState>>({
    claude: initial(),
    codex: initial(),
  });
  const [diag, setDiag] = useState<CliDiagnosticsDto | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [override, setOverride] = useState<{ provider: Provider; path: string }>({ provider: "claude", path: "" });

  const load = useCallback(async (provider: Provider) => {
    setState((s) => ({ ...s, [provider]: { ...s[provider], loading: true } }));
    try {
      const [status, candidates] = await Promise.all([
        window.workbench.cli.status(provider),
        window.workbench.cli.candidates(provider),
      ]);
      setState((s) => ({ ...s, [provider]: { status, candidates, loading: false, message: null } }));
    } catch (e) {
      setState((s) => ({
        ...s,
        [provider]: { ...s[provider], loading: false, message: e instanceof Error ? e.message : String(e) },
      }));
    }
  }, []);

  const loadAll = useCallback(async () => {
    const started = Date.now();
    await Promise.all(PROVIDERS.map(load));
    setDiag(await window.workbench.cli.diagnostics());
    setScannedAt(Date.now() - started);
  }, [load]);

  const rescan = async () => {
    await window.workbench.cli.refresh();
    await loadAll();
  };

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  const applyOverride = async (provider: Provider, binPath: string | null) => {
    const result = await window.workbench.cli.setOverride(provider, binPath);
    if (!result.ok) {
      setState((s) => ({ ...s, [provider]: { ...s[provider], message: result.message ?? "저장 실패" } }));
      return;
    }
    setOverride((o) => ({ ...o, path: "" }));
    await load(provider);
  };

  const detected = PROVIDERS.filter((p) => state[p].status?.installed).length;
  const pathIssues = diag?.missingInApp.length ?? 0;

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[84px] shrink-0 items-center px-6 pt-7">
        <div>
          <div className="text-[15px] font-semibold">설정</div>
          <div className="text-[11px] text-muted">이 Mac에서 사용할 도구와 앱 동작을 설정합니다.</div>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <nav className="w-[200px] shrink-0 px-3 py-5">
          <div className="label px-3 pb-2">앱</div>
          {(
            [
              { id: "general", label: "일반", icon: "settings" },
              { id: "cli", label: "CLI 찾기", icon: "terminal" },
              { id: "mcp", label: "MCP 서버", icon: "list" },
              { id: "snippets", label: "스니펫", icon: "copy" },
              { id: "schedules", label: "예약", icon: "clock" },
            ] as const
          ).map((item) => (
            <button
              key={item.id}
              onClick={() => onSection(item.id)}
              className={`flex w-full items-center gap-2 rounded-md px-3 py-2 text-left ${
                section === item.id ? "bg-panel-2 text-fg" : "text-muted hover:bg-panel-2/60 hover:text-fg"
              }`}
            >
              <Icon name={item.icon} size={13} />
              {item.label}
            </button>
          ))}
          <div className="px-3 py-2 text-muted-2">
            Git <span className="label ml-1">예정</span>
          </div>
        </nav>

        <div className="min-w-0 flex-1 overflow-y-auto px-7 py-6">
          <div className="mx-auto max-w-[940px]">
            {section === "general" ? (
              <GeneralSection />
            ) : section === "mcp" ? (
              <McpSection workspacePath={workspacePath} />
            ) : section === "snippets" ? (
              <SnippetsSection workspaces={workspaces} />
            ) : section === "schedules" ? (
              <SchedulesSection defaultCwd={workspacePath} />
            ) : (
              <>
            <div className="mb-5 flex items-start justify-between gap-6">
              <div>
                <h1 className="text-[20px] font-semibold">CLI 찾기</h1>
                <p className="mt-1 text-muted">이 Mac에 설치된 Claude Code와 Codex CLI를 찾습니다. 사용할 버전과 실행 파일 경로를 바꿀 수 있습니다.</p>
              </div>
              <button
                onClick={() => void rescan()}
                className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-3.5 py-2 font-medium text-on-primary hover:bg-primary-hover"
              >
                <Icon name="refresh" size={13} />
                다시 찾기
              </button>
            </div>

            <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
              <span className={`h-2 w-2 rounded-full ${scannedAt === null ? "bg-muted animate-pulse" : "bg-ok"}`} />
              <span className="font-medium">{scannedAt === null ? "찾는 중" : "찾기 완료"}</span>
              <span className="text-muted">
                {detected}개 연결 가능{pathIssues > 0 ? ` · 셸 PATH에서 발견 ${pathIssues}개` : ""}
              </span>
              <span className="mono ml-auto text-[10px] text-muted">
                {scannedAt !== null && `${(scannedAt / 1000).toFixed(1)}s`}
              </span>
            </div>

            <div className="mb-4 grid grid-cols-1 gap-4 xl:grid-cols-2">
              {PROVIDERS.map((p) => (
                <ProviderCard
                  key={p}
                  provider={p}
                  state={state[p]}
                  onSelect={(path) => void applyOverride(p, path)}
                  onReset={() => void applyOverride(p, null)}
                />
              ))}
            </div>

            <div className="mb-4">
              <LspCard />
            </div>

            <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
              <div className="rounded-lg border border-line bg-panel p-4">
                <div className="mb-3 flex items-center gap-2 font-medium">
                  <Icon name="branch" size={14} className="text-accent" />
                  PATH 진단
                </div>
                {diag ? (
                  <>
                    {diag.missingInApp.length > 0 ? (
                      // 앱은 셸 PATH 를 항상 합쳐 쓰므로 이건 경고가 아니라 "어디서 찾았는지" 안내다.
                      diag.missingInApp.map((m) => (
                        <div key={m.dir} className="mb-2 rounded-md border border-line bg-panel-2/60 px-3 py-2" data-path-note>
                          <div className="flex items-center gap-2 font-medium">
                            <Icon name="info" size={12} className="shrink-0 text-muted" />
                            {LABEL[m.provider][0]} 실행 파일을 셸 PATH에서 찾았습니다
                          </div>
                          <div className="mono mt-1 break-all text-[11px] text-muted" title={m.dir}>
                            {m.dir}
                          </div>
                          <div className="mt-0.5 text-[11px] text-muted">
                            앱은 셸 PATH도 함께 사용하므로 이 위치의 도구를 실행할 수 있습니다.
                          </div>
                        </div>
                      ))
                    ) : (
                      <div className={`mb-2 rounded-md border px-3 py-2 ${detected > 0 ? "border-ok/30 bg-ok-bg text-ok" : "border-line text-muted"}`}>
                        {detected > 0 ? "발견한 CLI의 경로를 앱에서도 확인했습니다." : "CLI를 찾은 뒤 실행 경로를 확인할 수 있습니다."}
                      </div>
                    )}
                    <dl className="mono mt-3 grid grid-cols-[110px_1fr] gap-y-1.5 text-[10.5px]">
                      <dt className="label">로그인 셸</dt>
                      <dd className="truncate text-right text-ok">{diag.loginShell}</dd>
                      <dt className="label">앱 PATH</dt>
                      <dd className="truncate text-right text-muted" title={diag.appPathDirs.join(":")}>
                        {diag.appPathDirs.length}개 디렉토리
                      </dd>
                      <dt className="label">셸 PATH</dt>
                      <dd className="truncate text-right text-muted" title={diag.shellPathDirs.join(":")}>
                        {diag.shellPathDirs.length}개 디렉토리
                      </dd>
                      <dt className="label">찾는 방식</dt>
                      <dd className="truncate text-right text-muted">로그인 셸 PATH 순회 + --version 확인</dd>
                    </dl>
                  </>
                ) : (
                  <p className="text-muted">진단 중…</p>
                )}
              </div>

              <div className="rounded-lg border border-line bg-panel p-4">
                <div className="mb-1 flex items-center gap-2 font-medium">
                  <Icon name="edit" size={14} className="text-accent" />
                  실행 파일 직접 지정
                </div>
                <p className="mb-3 text-[11px] text-muted">
                  원하는 버전이 자동으로 선택되지 않았다면 실행 파일의 전체 경로를 입력하세요.
                </p>
                <div className="flex gap-2">
                  <select
                    value={override.provider}
                    onChange={(e) => setOverride((o) => ({ ...o, provider: e.target.value as Provider }))}
                    className="rounded-md border border-line bg-bg px-2 py-1.5"
                  >
                    {PROVIDERS.map((p) => (
                      <option key={p} value={p}>
                        {LABEL[p][0]}
                      </option>
                    ))}
                  </select>
                  <input
                    value={override.path}
                    onChange={(e) => setOverride((o) => ({ ...o, path: e.target.value }))}
                    placeholder="/absolute/path/to/executable"
                    className="mono min-w-0 flex-1 rounded-md border border-line bg-bg px-2.5 py-1.5 outline-none focus:border-accent/50"
                    style={{ userSelect: "text" }}
                  />
                  <button
                    disabled={!override.path.trim()}
                    onClick={() => void applyOverride(override.provider, override.path.trim())}
                    className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2 disabled:opacity-40"
                  >
                    적용
                  </button>
                </div>
              </div>
            </div>

            {info && (
              <div className="mono mt-6 space-y-1 text-[10px] text-muted">
                <p>설정 저장 위치: {info.userDataPath}</p>
                <p>
                  로그 파일: {info.logPath}{" "}
                  <button
                    onClick={() => void window.workbench.app.openLogs()}
                    className="ml-1 rounded border border-line px-1.5 py-0.5 hover:bg-panel-2"
                  >
                    폴더 열기
                  </button>
                </p>
              </div>
            )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ===== 일반 =====

const LINK_MODE_OPTIONS: { value: LinkOpenMode; label: string; hint: string }[] = [
  { value: "ask", label: "클릭할 때마다 묻기", hint: "링크를 누를 때 열 위치를 고릅니다. 선택창에서 '기억'을 켜면 다음부터 같은 방식으로 엽니다." },
  { value: "app", label: "인앱 브라우저", hint: "오른쪽 패널의 브라우저 탭에서 엽니다." },
  { value: "external", label: "기본 브라우저", hint: "macOS 기본 브라우저에서 엽니다." },
];

const WARM_OPTIONS: { value: WarmTarget; label: string; hint: string }[] = [
  { value: "active", label: "보고 있는 탭", hint: "탭을 열거나 이동하면 Claude·Codex를 미리 실행해 첫 응답의 준비 시간을 줄입니다." },
  { value: "off", label: "끄기", hint: "메시지를 보낼 때 실행합니다. 대기 중 메모리 사용은 줄지만 첫 응답을 준비하는 시간이 필요합니다." },
];

/** 링크 열기 방식(renderer localStorage) · 예열 · 유휴 시간(main settings.json). 바꾸면 바로 저장·적용된다. */
const THEME_OPTIONS: { value: ThemeMode; label: string; hint: string }[] = [
  { value: "system", label: "시스템 따라가기", hint: "macOS 화면 모드가 바뀌면 함께 바뀝니다." },
  { value: "light", label: "밝게", hint: "항상 밝은 배경." },
  { value: "dark", label: "어둡게", hint: "항상 어두운 배경." },
];

const NOTIFY_OPTIONS: { value: NotifyOnDone; label: string; hint: string }[] = [
  { value: "always", label: "항상", hint: "응답이 끝나면 macOS 알림을 보냅니다. 알림을 누르면 해당 탭으로 이동합니다." },
  { value: "unfocused", label: "안 보고 있을 때만", hint: "다른 앱이나 다른 채팅 탭을 보고 있을 때 알립니다." },
  { value: "off", label: "끄기", hint: "응답 완료는 알리지 않습니다. 작업 승인 요청은 계속 알립니다." },
];

function GeneralSection() {
  const [linkMode, setLinkModeState] = useState<LinkOpenMode>(() => getLinkOpenMode());
  const [settings, setSettings] = useState<AppSettingsDto | null>(null);
  const [idleDraft, setIdleDraft] = useState("");
  const [concurrentDraft, setConcurrentDraft] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const adopt = (s: AppSettingsDto) => {
    setSettings(s);
    setIdleDraft(String(s.sessionIdleMinutes));
    setConcurrentDraft(String(s.maxConcurrent));
  };
  useEffect(() => {
    window.workbench.app.getSettings().then(adopt);
  }, []);

  const save = async (patch: Partial<AppSettingsDto>) => {
    try {
      adopt(await window.workbench.app.setSettings(patch));
      setMsg({ ok: true, text: "저장했습니다." });
    } catch (e) {
      setMsg({ ok: false, text: e instanceof Error ? e.message : String(e) });
    }
  };
  /** 숫자 입력 하나를 저장한다. 범위 밖이면 저장하지 않고 이유를 보여 준다. */
  const saveNumber = (key: "sessionIdleMinutes" | "maxConcurrent", draft: string, min: number, max: number, label: string) => {
    const n = Number(draft);
    if (!Number.isFinite(n) || n < min || n > max) {
      setMsg({ ok: false, text: `${label}는 ${min}~${max} 사이여야 합니다.` });
      return;
    }
    if (settings && Math.round(n) === settings[key]) return;
    void save({ [key]: Math.round(n) });
  };
  const saveIdle = () => saveNumber("sessionIdleMinutes", idleDraft, SESSION_IDLE_MINUTES_MIN, SESSION_IDLE_MINUTES_MAX, "대기 시간(분)");
  const saveConcurrent = () => saveNumber("maxConcurrent", concurrentDraft, MAX_CONCURRENT_MIN, MAX_CONCURRENT_MAX, "동시에 작업할 채팅 수");
  const blurOnEnter = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter") e.currentTarget.blur();
  };

  const [installMsg, setInstallMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [installed, setInstalled] = useState<InstallStatusDto | null>(null);
  const refreshInstalled = () => window.workbench.app.installStatus().then(setInstalled).catch(() => setInstalled(null));
  useEffect(() => {
    void refreshInstalled();
  }, []);
  const installCli = async () => {
    const r = await window.workbench.app.installCli();
    void refreshInstalled();
    if (!r.ok) setInstallMsg({ ok: false, text: r.error });
    else if (r.hint) setInstallMsg({ ok: false, text: r.hint });
    else setInstallMsg({ ok: true, text: `설치했습니다: ${shorten(r.path)}` });
  };
  const installSkill = async (agent: "claude" | "codex") => {
    const r = await window.workbench.app.installSkill(agent);
    void refreshInstalled();
    if (!r.ok) setInstallMsg({ ok: false, text: r.error });
    else setInstallMsg({ ok: true, text: `설치했습니다: ${r.paths.map(shorten).join(", ")} — 새 세션부터 보입니다.` });
  };
  /** 설치 항목 행: 상태 점·문구·버튼 글자를 한 곳에서 정한다. */
  const installRows = () => {
    const rows: { key: string; name: string; path: string; state: string; tone: string; dot: string; button: string; disabled: boolean; action: () => Promise<void> }[] = [];
    const cli = installed?.cli;
    rows.push({
      key: "cli",
      name: "atelier 명령",
      path: cli?.path ?? "~/.local/bin/atelier",
      state: !cli ? "" : !cli.installed ? "설치되지 않음" : !cli.current ? "다른 앱 위치를 가리킴" : !cli.onPath ? "설치됨 · 셸 PATH에 ~/.local/bin을 추가해야 합니다" : "설치됨",
      tone: !cli || !cli.installed ? "text-muted" : cli.current && cli.onPath ? "text-ok" : "text-warn",
      dot: !cli || !cli.installed ? "bg-muted-2/50" : cli.current && cli.onPath ? "bg-ok" : "bg-warn",
      button: cli?.installed ? "다시 설치" : "설치",
      disabled: !installed,
      action: installCli,
    });
    for (const s of installed?.skills ?? []) {
      rows.push({
        key: `skill-${s.agent}`,
        name: `${s.label} 스킬`,
        path: s.path,
        state: !s.available ? "이 Mac에서 찾지 못함" : !s.installed ? "설치되지 않음" : s.current ? "설치됨" : "구버전 — 업데이트 필요",
        tone: !s.available || !s.installed ? "text-muted" : s.current ? "text-ok" : "text-warn",
        dot: !s.available || !s.installed ? "bg-muted-2/50" : s.current ? "bg-ok" : "bg-warn",
        button: !s.installed ? "설치" : s.current ? "다시 설치" : "업데이트",
        disabled: !s.available,
        action: () => installSkill(s.agent),
      });
    }
    return rows;
  };

  const radioCls = (on: boolean) => `flex cursor-pointer items-start gap-2.5 rounded-md border px-3 py-2 ${on ? "border-accent/50 bg-panel-2" : "border-line hover:bg-panel-2/60"}`;

  return (
    <>
      <div className="mb-5">
        <h1 className="text-[20px] font-semibold">일반</h1>
        <p className="mt-1 text-muted">화면과 알림, 브라우저, Claude·Codex의 실행 방식을 설정합니다.</p>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="theme">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="sparkles" size={14} className="text-accent" />
          화면 테마
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">인앱 브라우저에 표시되는 웹사이트에는 적용되지 않습니다.</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
          {THEME_OPTIONS.map((o) => (
            <label key={o.value} className={radioCls(settings?.theme === o.value)}>
              <input
                type="radio"
                name="theme"
                value={o.value}
                checked={settings?.theme === o.value}
                disabled={!settings}
                onChange={() => {
                  applyThemeMode(o.value); // 저장 응답을 기다리지 않고 바로 칠한다
                  void save({ theme: o.value });
                }}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-[12px] leading-5 text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="notify">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="alert" size={14} className="text-accent" />
          응답 완료 알림
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">응답이 끝났을 때 알림을 받을지 정합니다. 다른 앱을 보고 있을 때 작업 승인이 필요하면 이 설정과 관계없이 알립니다.</p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
          {NOTIFY_OPTIONS.map((o) => (
            <label key={o.value} className={radioCls(settings?.notifyOnDone === o.value)}>
              <input type="radio" name="notifyOnDone" value={o.value} checked={settings?.notifyOnDone === o.value} disabled={!settings} onChange={() => void save({ notifyOnDone: o.value })} className="mt-0.5" />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-[12px] leading-5 text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="cli">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="terminal" size={14} className="text-accent" />
          명령줄 도구와 에이전트 스킬
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          <code>atelier</code> 명령을 설치하면 터미널에서 워크스페이스와 탭을 열고 관리할 수 있습니다.
          스킬도 설치하면 Claude Code와 Codex에 말로 요청해 Atelier를 조작할 수 있습니다.
        </p>
        <div className="divide-y divide-line rounded-md border border-line" data-install-list>
          {installRows().map((row) => (
            <div key={row.key} className="flex items-center gap-3 px-3 py-2" data-install-row={row.key}>
              <span className={`h-2 w-2 shrink-0 rounded-full ${row.dot}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-medium">{row.name}</span>
                  <span className={`text-[11px] ${row.tone}`} data-install-state>
                    {row.state}
                  </span>
                </div>
                <div className="mono truncate text-[10.5px] text-muted-2" title={row.path}>
                  {shorten(row.path)}
                </div>
              </div>
              <button
                onClick={() => void row.action()}
                disabled={row.disabled}
                className="shrink-0 rounded-md border border-line px-2.5 py-1 text-[11.5px] text-muted hover:bg-panel-2 hover:text-fg disabled:opacity-40"
                data-install-button={row.key}
              >
                {row.button}
              </button>
            </div>
          ))}
        </div>
        {installMsg && (
          <p className={`mono mt-2 text-[11px] ${installMsg.ok ? "text-ok" : "text-err"}`} data-install-msg>
            {installMsg.text}
          </p>
        )}
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="keep-browser-login">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="shield" size={14} className="text-accent" />
          인앱 브라우저 로그인 유지
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          앱을 종료할 때 로그인에 쓰이는 쿠키를 저장하고, 다시 열 때 복원합니다. 사이트의 보안 정책이나 로그인 만료에 따라 다시 로그인해야 할 수 있습니다.
          <br />
          저장한 쿠키는 이 Mac의 앱 데이터 폴더에 암호화 없이 보관되며, 현재 사용자만 읽을 수 있습니다. 끄면 복원을 위해 저장한 쿠키 파일을 삭제합니다.
        </p>
        <label className="flex cursor-pointer items-center gap-2 text-[12.5px]">
          <input
            type="checkbox"
            checked={settings?.keepBrowserLogin ?? true}
            disabled={!settings}
            onChange={(e) => void save({ keepBrowserLogin: e.target.checked })}
            data-keep-browser-login
          />
          <span>다음 실행을 위해 로그인 정보 저장</span>
        </label>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="storage">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="folder" size={14} className="text-accent" />
          저장 위치
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          워크스페이스·채팅 기록·설정은 앱 데이터 폴더에 저장됩니다. 격리 세션·팬아웃에서 만드는 작업 사본(git worktree)은 아래 폴더에 만들어지고, 위치를 바꾸면 새로 만드는 것부터 적용됩니다. 이미 만든 작업 사본은 옮기지 않습니다.
        </p>
        {settings && (
          <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-2 text-[12.5px]">
            <span className="text-muted">앱 데이터</span>
            <span className="mono truncate text-[11.5px]" title={settings.dataDir} data-data-dir>
              {shorten(settings.dataDir)}
            </span>
            <button onClick={() => void window.workbench.app.openPath("data")} className="justify-self-end rounded-md border border-line px-2.5 py-1 hover:bg-panel-2">
              폴더 열기
            </button>

            <span className="text-muted">작업 사본</span>
            <span className="mono truncate text-[11.5px]" title={settings.worktreeDir} data-worktree-dir>
              {shorten(settings.worktreeDir)}
              {!settings.worktreeDirCustom && <span className="ml-1.5 font-sans text-muted">(기본값)</span>}
            </span>
            <span className="flex items-center gap-1.5 justify-self-end">
              <button onClick={() => void window.workbench.app.openPath("worktrees")} className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2">
                폴더 열기
              </button>
              <button
                onClick={() => void window.workbench.app.pickWorktreeDir().then(adopt)}
                className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2"
                data-worktree-dir-pick
              >
                변경…
              </button>
              {settings.worktreeDirCustom && (
                <button onClick={() => void save({ worktreeDirCustom: false })} className="rounded-md border border-line px-2.5 py-1 hover:bg-panel-2" data-worktree-dir-reset>
                  기본값으로
                </button>
              )}
            </span>
          </div>
        )}
        <WorktreeCleanup />
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="link-open">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="globe" size={14} className="text-accent" />
          링크 열기 방식
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          채팅에 있는 웹 링크를 어디에서 열지 정합니다. ⌘클릭은 기본 브라우저, ⌥클릭은 인앱 브라우저로 엽니다. ⇧클릭하면 다시 선택할 수 있습니다.
        </p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-3">
          {LINK_MODE_OPTIONS.map((o) => (
            <label key={o.value} className={radioCls(linkMode === o.value)}>
              <input
                type="radio"
                name="linkOpenMode"
                value={o.value}
                checked={linkMode === o.value}
                onChange={() => {
                  setLinkOpenMode(o.value);
                  setLinkModeState(o.value);
                }}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-[12px] leading-5 text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="warm">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="sparkles" size={14} className="text-accent" />
          탭을 열 때 미리 준비
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          메시지를 보내기 전에 Claude·Codex를 실행해 둡니다. 첫 응답의 준비 시간을 줄이는 대신 대기 중에도 메모리를 사용합니다.
        </p>
        <div className="grid grid-cols-1 gap-2 xl:grid-cols-2">
          {WARM_OPTIONS.map((o) => (
            <label key={o.value} className={radioCls(settings?.warmTarget === o.value)}>
              <input
                type="radio"
                name="warmTarget"
                value={o.value}
                checked={settings?.warmTarget === o.value}
                disabled={!settings}
                onChange={() => void save({ warmTarget: o.value })}
                className="mt-0.5"
              />
              <span>
                <span className="block font-medium">{o.label}</span>
                <span className="block text-[12px] leading-5 text-muted">{o.hint}</span>
              </span>
            </label>
          ))}
        </div>
      </div>

      <div className="mb-4 rounded-lg border border-line bg-panel p-4" data-setting="idle">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="clock" size={14} className="text-accent" />
          사용하지 않을 때 메모리 정리
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          작업 없이 아래 시간만큼 대기한 탭의 Claude·Codex를 종료해 메모리를 줄입니다. 대화 기록은 유지되며, 다음 메시지를 보내면 다시 실행합니다. 변경한 시간은 현재 대기 중인 탭에도 적용됩니다.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={SESSION_IDLE_MINUTES_MIN}
            max={SESSION_IDLE_MINUTES_MAX}
            value={idleDraft}
            disabled={!settings}
            onChange={(e) => setIdleDraft(e.target.value)}
            onBlur={saveIdle}
            onKeyDown={blurOnEnter}
            className="mono w-24 rounded-md border border-line bg-inset px-2.5 py-1.5 text-fg outline-none focus:border-accent/50"
            style={{ userSelect: "text" }}
            data-idle-minutes
          />
          <span className="text-muted">분</span>
          <span className="ml-2 text-[11.5px] text-muted-2">
            {SESSION_IDLE_MINUTES_MIN}~{SESSION_IDLE_MINUTES_MAX}분 · 기본 10분
          </span>
        </div>
      </div>

      <div className="rounded-lg border border-line bg-panel p-4" data-setting="concurrent">
        <div className="mb-1 flex items-center gap-2 font-medium">
          <Icon name="list" size={14} className="text-accent" />
          동시에 작업할 채팅 수
          <span className="label ml-1 rounded bg-panel-2 px-1.5 py-0.5 text-muted">고급</span>
        </div>
        <p className="mb-3 text-[12px] leading-5 text-muted">
          Claude·Codex 채팅에 함께 적용됩니다. 권한 승인을 기다리는 채팅도 하나로 셉니다. 넘치는 메시지는 자리가 나면 순서대로 시작합니다.
          수를 줄여도 진행 중인 작업은 계속됩니다. 수를 늘리면 대기 중인 작업이 시작될 수 있습니다.
        </p>
        <div className="flex items-center gap-2">
          <input
            type="number"
            min={MAX_CONCURRENT_MIN}
            max={MAX_CONCURRENT_MAX}
            value={concurrentDraft}
            disabled={!settings}
            onChange={(e) => setConcurrentDraft(e.target.value)}
            onBlur={saveConcurrent}
            onKeyDown={blurOnEnter}
            className="mono w-24 rounded-md border border-line bg-inset px-2.5 py-1.5 text-fg outline-none focus:border-accent/50"
            style={{ userSelect: "text" }}
            data-max-concurrent
          />
          <span className="text-muted">개</span>
          <span className="ml-2 text-[11.5px] text-muted-2">
            {MAX_CONCURRENT_MIN}~{MAX_CONCURRENT_MAX}개 · 기본 4개
          </span>
        </div>
      </div>

      {msg && <p className={`mono mt-3 text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`}>{msg.text}</p>}
    </>
  );
}

// ===== MCP 서버 =====

const MCP_STATUS: Record<McpServerStatusDto["status"], { label: string; cls: string }> = {
  connected: { label: "연결됨", cls: "bg-ok-bg text-ok" },
  failed: { label: "실패", cls: "bg-err-bg text-err" },
  "needs-auth": { label: "인증 필요", cls: "bg-warn-bg text-warn" },
  pending: { label: "연결 중", cls: "bg-panel-2 text-muted" },
  disabled: { label: "비활성", cls: "bg-panel-2 text-muted-2" },
};

/**
 * 터미널 /mcp 화면의 앱 버전. SDK 컨트롤 요청으로 같은 정보(상태·에러·도구)를 읽기 전용으로 보여준다.
 * 재연결·토글은 세션 단위 프로세스에만 적용되어 이 앱(턴마다 새 프로세스)에선 의미가 없어 두지 않았다.
 */
function McpSection({ workspacePath }: { workspacePath: string | null }) {
  const [servers, setServers] = useState<McpServerStatusDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    if (!workspacePath) return;
    setLoading(true);
    setError(null);
    try {
      setServers(await window.workbench.mcp.status(workspacePath));
      setCheckedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [workspacePath]);

  useEffect(() => {
    setServers(null);
    void load();
  }, [load]);

  const counts = (servers ?? []).reduce<Record<string, number>>((acc, s) => {
    acc[s.status] = (acc[s.status] ?? 0) + 1;
    return acc;
  }, {});

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div>
          <h1 className="text-[20px] font-semibold">MCP 서버</h1>
          <p className="mt-1 text-muted">
            Claude Code가 이 작업 경로에서 사용할 MCP 서버의 연결 상태입니다. 설정은 터미널의{" "}
            <code>claude mcp</code> 명령이나 <code>.mcp.json</code> 으로 바꿉니다.
          </p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading || !workspacePath}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-3.5 py-2 font-medium text-on-primary hover:bg-primary-hover disabled:opacity-40"
        >
          <Icon name="refresh" size={13} className={loading ? "animate-spin" : ""} />
          다시 확인
        </button>
      </div>

      {!workspacePath ? (
        <p className="text-muted">작업 경로를 선택한 채팅 탭을 먼저 여세요. 해당 작업 경로에서 사용할 수 있는 MCP 서버를 확인합니다.</p>
      ) : (
        <>
          <div className="mb-4 flex items-center gap-3 rounded-lg border border-line bg-panel px-4 py-3">
            <span className={`h-2 w-2 rounded-full ${loading ? "bg-muted animate-pulse" : error ? "bg-err" : "bg-ok"}`} />
            <span className="font-medium">
              {loading ? "확인 중 (서버 연결을 최대 10초 기다립니다)" : error ? "확인 실패" : `${servers?.length ?? 0}개 서버`}
            </span>
            {!loading && !error && servers && (
              <span className="text-muted">
                연결 {counts.connected ?? 0} · 실패 {counts.failed ?? 0} · 인증 필요 {counts["needs-auth"] ?? 0}
                {(counts.pending ?? 0) > 0 && ` · 연결 중 ${counts.pending}`}
                {(counts.disabled ?? 0) > 0 && ` · 비활성 ${counts.disabled}`}
              </span>
            )}
            <span className="mono ml-auto truncate text-[10px] text-muted" title={workspacePath}>
              {shorten(workspacePath)}
              {checkedAt && ` · ${new Date(checkedAt).toLocaleTimeString("ko-KR")}`}
            </span>
          </div>
          {error && <div className="mb-4 rounded-md border border-err/40 bg-err-bg px-3 py-2 text-err">{error}</div>}

          <div className="flex flex-col gap-3">
            {servers?.map((s) => (
              <McpServerCard key={s.name} server={s} />
            ))}
            {servers && servers.length === 0 && !loading && <p className="text-muted">등록된 MCP 서버가 없습니다.</p>}
          </div>
        </>
      )}
    </>
  );
}

function McpServerCard({ server: s }: { server: McpServerStatusDto }) {
  const [open, setOpen] = useState(false);
  const st = MCP_STATUS[s.status];
  return (
    <div className="rounded-lg border border-line bg-panel px-4 py-3">
      <div className="flex items-center gap-3">
        <span className="font-medium">{s.name}</span>
        <span className={`label rounded px-1.5 py-0.5 ${st.cls}`}>{st.label}</span>
        {s.scope && <span className="label">{s.scope}</span>}
        {s.serverInfo && (
          <span className="mono text-[10px] text-muted">
            {s.serverInfo.name} {s.serverInfo.version}
          </span>
        )}
        {s.tools.length > 0 && (
          <button onClick={() => setOpen((o) => !o)} className="ml-auto flex items-center gap-1 text-muted hover:text-fg">
            도구 {s.tools.length}개
            <Icon name="chevronDown" size={12} className={open ? "rotate-180" : ""} />
          </button>
        )}
      </div>
      {s.target && (
        <div className="mono mt-1.5 truncate text-[10.5px] text-muted" title={s.target}>
          {s.transport && <span className="mr-2 uppercase">{s.transport}</span>}
          {s.target}
        </div>
      )}
      {s.error && (
        <div className="mono mt-2 whitespace-pre-wrap rounded-md bg-err-bg px-3 py-2 text-[11px] text-err" style={{ userSelect: "text" }}>
          {s.error}
        </div>
      )}
      {s.status === "needs-auth" && (
        <p className="mt-2 text-[11px] text-warn">
          브라우저 인증이 필요합니다. 터미널에서 <code>claude</code> 를 열고 <code>/mcp</code> 로 인증하세요.
        </p>
      )}
      {open && (
        <ul className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 border-t border-line pt-3">
          {s.tools.map((t) => (
            <li key={t.name} className="min-w-0">
              <div className="mono truncate text-[11.5px]">{t.name}</div>
              {t.description && <div className="truncate text-[10.5px] text-muted" title={t.description}>{t.description}</div>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ProviderCard({
  provider,
  state,
  onSelect,
  onReset,
}: {
  provider: Provider;
  state: ProviderState;
  onSelect: (path: string) => void;
  onReset: () => void;
}) {
  const { status, candidates, loading, message } = state;
  const installed = status?.installed ?? false;
  const [name, vendor] = LABEL[provider];

  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-center gap-3">
        <ProviderLogo provider={provider} size={36} />
        <div className="flex-1">
          <div className="text-[14px] font-semibold">{name}</div>
          <div className="text-[11px] text-muted">{vendor}</div>
        </div>
        <span
          className={`label rounded px-2 py-1 ${
            loading ? "bg-panel-2 text-muted" : installed ? "bg-ok-bg text-ok" : "bg-err-bg text-err"
          }`}
        >
          {loading ? "찾는 중" : installed ? "연결 가능" : "미설치"}
        </span>
      </div>

      <div className="rounded-md bg-bg px-3 py-2.5">
        <div className="flex items-center justify-between">
          <span className="label">버전</span>
          <span className="mono">{status?.version ?? (loading ? "…" : "-")}</span>
        </div>
        <div className="mono mt-1 truncate text-[10.5px] text-muted" title={status?.path ?? ""}>
          {status?.path ?? status?.error ?? ""}
        </div>
      </div>

      {message && <p className="mt-2 text-warn">{message}</p>}

      <div className="mt-3 flex items-center justify-between text-[11px] text-muted">
        <span>
          {status?.source === "override" ? "사용자 지정 경로" : "자동으로 찾기"}
          {candidates.length > 1 && ` · 후보 ${candidates.length}개`}
        </span>
        {status?.source === "override" && (
          <button onClick={onReset} className="underline-offset-2 hover:underline">
            자동으로 찾도록 변경
          </button>
        )}
      </div>

      {candidates.length > 1 && (
        <ul className="mt-2 flex flex-col gap-1 border-t border-line pt-2">
          {candidates.map((c) => (
            <li key={c.path}>
              <button
                disabled={!c.verified}
                onClick={() => onSelect(c.path)}
                className={`mono flex w-full items-center gap-2 rounded px-2 py-1 text-left text-[10.5px] ${
                  c.path === status?.path ? "bg-panel-2" : c.verified ? "hover:bg-panel-2/60" : "cursor-not-allowed opacity-50"
                }`}
              >
                <span className="truncate">{c.path}</span>
                <span className="ml-auto shrink-0 text-muted">{c.verified ? c.versionOutput : "응답 없음"}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ===== 스니펫 =====

function SnippetsSection({ workspaces }: { workspaces: { id: string; name: string }[] }) {
  const items = useSnippets();
  const [editing, setEditing] = useState<Partial<SnippetDto> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wsName = (id: string | null) =>
    id === null ? "모든 워크스페이스" : (workspaces.find((w) => w.id === id)?.name ?? "(삭제된 워크스페이스)");
  const sorted = items
    .slice()
    .sort((a, b) => (a.workspaceId ?? "").localeCompare(b.workspaceId ?? "") || a.name.localeCompare(b.name));

  const save = async () => {
    if (!editing) return;
    const r = await window.workbench.snippets.save({
      id: editing.id,
      name: editing.name ?? "",
      text: editing.text ?? "",
      workspaceId: editing.workspaceId ?? null,
    });
    if (r.ok) {
      setEditing(null);
      setError(null);
    } else setError(r.error);
  };

  return (
    <>
      <div className="mb-5 flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h1 className="text-[20px] font-semibold">스니펫</h1>
          <p className="mt-1 text-muted">
            자주 붙이는 지시문을 이름으로 저장합니다. 입력창에서 <span className="mono">/이름</span> 을 치면 본문이 들어갑니다.
            입력창의 "스니펫" 버튼으로도 저장할 수 있습니다.
          </p>
        </div>
        <button
          onClick={() => {
            setEditing({ name: "", text: "", workspaceId: null });
            setError(null);
          }}
          className="flex shrink-0 items-center gap-2 whitespace-nowrap rounded-md bg-primary px-3.5 py-2 font-medium text-on-primary hover:bg-primary-hover"
          data-snippet-new
        >
          <Icon name="plus" size={13} />
          새 스니펫
        </button>
      </div>

      {editing && (
        <div className="mb-5 flex flex-col gap-2 rounded-lg border border-accent/40 bg-panel p-4" data-snippet-editor>
          <div className="flex gap-2">
            <label className="flex flex-1 items-center gap-2 rounded-md border border-line bg-inset px-2.5 py-1.5">
              <span className="mono text-muted">/</span>
              <input
                autoFocus
                value={editing.name ?? ""}
                onChange={(e) => setEditing({ ...editing, name: e.target.value })}
                placeholder="이름 (공백 없이)"
                className="mono min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted"
                style={{ userSelect: "text" }}
              />
            </label>
            <select
              value={editing.workspaceId ?? ""}
              onChange={(e) => setEditing({ ...editing, workspaceId: e.target.value || null })}
              className="rounded-md border border-line bg-inset px-2 py-1.5 text-fg outline-none"
            >
              <option value="">모든 워크스페이스</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
          </div>
          <textarea
            value={editing.text ?? ""}
            onChange={(e) => setEditing({ ...editing, text: e.target.value })}
            rows={5}
            placeholder="입력창에 들어갈 본문"
            className="w-full resize-y rounded-md border border-line bg-inset px-2.5 py-2 leading-5 text-fg outline-none placeholder:text-muted"
            style={{ userSelect: "text" }}
          />
          <div className="flex items-center gap-2">
            {error && <span className="text-err">{error}</span>}
            <button
              onClick={() => setEditing(null)}
              className="ml-auto rounded-md border border-line px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg"
            >
              취소
            </button>
            <button
              onClick={() => void save()}
              className="rounded-md bg-primary px-3.5 py-1.5 font-medium text-on-primary hover:bg-primary-hover"
              data-snippet-editor-save
            >
              저장
            </button>
          </div>
        </div>
      )}

      {sorted.length === 0 ? (
        <div className="rounded-lg border border-dashed border-line px-4 py-8 text-center text-muted">
          아직 스니펫이 없습니다.
        </div>
      ) : (
        <ul className="flex flex-col gap-2" data-snippet-list>
          {sorted.map((s) => (
            <li
              key={s.id}
              className="flex items-start gap-3 rounded-lg border border-line bg-panel px-4 py-3"
              data-snippet={s.name}
            >
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="mono text-[13px] text-fg">/{s.name}</span>
                  <span className="label rounded bg-panel-2 px-1.5 py-0.5 text-muted">{wsName(s.workspaceId)}</span>
                </div>
                <p className="mt-1 truncate text-muted" title={s.text}>
                  {snippetSummary(s.text, 140)}
                </p>
              </div>
              <button
                onClick={() => {
                  setEditing({ ...s });
                  setError(null);
                }}
                className="rounded-md p-1.5 text-muted hover:bg-panel-2 hover:text-fg"
                title="편집"
              >
                <Icon name="edit" size={13} />
              </button>
              <button
                onClick={() => void window.workbench.snippets.remove(s.id)}
                className="rounded-md p-1.5 text-muted hover:bg-err-bg hover:text-err"
                title="삭제"
                data-snippet-delete
              >
                <Icon name="trash" size={13} />
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// ===== 언어 서버 (TS/JS) =====

function LspCard() {
  const [statuses, setStatuses] = useState<LspStatusDto[] | null>(null);
  const load = useCallback(() => {
    window.workbench.lsp.status().then(setStatuses);
  }, []);
  useEffect(load, [load]);
  return (
    <div className="rounded-lg border border-line bg-panel p-4" data-lsp-card>
      <div className="mb-2 flex items-center gap-2 font-medium">
        <Icon name="braces" size={14} className="text-accent" />
        언어 서버
      </div>
      <p className="mb-3 text-muted">
        코드 자동완성, 오류 표시, 마우스를 올렸을 때의 설명, 정의로 이동(F12)에 필요한 도구입니다. 파일을 편집할 때 자동으로 실행됩니다.
      </p>
      <div className="flex flex-col gap-3">
        {(statuses ?? []).map((st) => (
          <LspServerRow key={st.serverId} status={st} onChanged={load} />
        ))}
      </div>
    </div>
  );
}

function LspServerRow({ status, onChanged }: { status: LspStatusDto; onChanged: () => void }) {
  const [path, setPath] = useState(status.override ?? "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  useEffect(() => setPath(status.override ?? ""), [status.override]);
  const save = async (p: string | null) => {
    const r = await window.workbench.lsp.setPath(status.serverId, p);
    setMsg(r.ok ? { ok: true, text: p ? "경로를 저장했습니다. 언어 서버가 새로 시작될 때 적용됩니다. 바로 적용하려면 Atelier를 다시 시작하세요." : "실행 파일을 자동으로 찾도록 저장했습니다. 언어 서버가 새로 시작될 때 적용됩니다. 바로 적용하려면 Atelier를 다시 시작하세요." } : { ok: false, text: r.error });
    onChanged();
  };
  return (
    <div className="rounded-md border border-line bg-panel-2/40 p-3" data-lsp-server={status.serverId}>
      <div className="mb-1.5 flex items-center gap-2 font-medium">
        {status.label}
        <span className={`label ml-auto rounded px-1.5 py-0.5 ${status.installed ? "bg-ok-bg text-ok" : "bg-warn-bg text-warn"}`}>
          {status.installed ? `연결 가능 · ${status.version ?? "버전 미상"}` : "미설치"}
        </span>
      </div>
      {!status.installed && (
        <p className="mb-2 text-muted">
          설치: <code className="mono rounded bg-inset px-1">{status.hint}</code>
        </p>
      )}
      {status.path && !status.override && (
        <div className="mono mb-2 truncate text-[11px] text-muted" title={status.path}>
          자동으로 찾은 경로: {status.path}
        </div>
      )}
      {status.installed && status.serverId === "typescript" && (
        <div className="mono mb-2 truncate text-[11px] text-muted" title={status.typescriptLib ?? ""}>
          TypeScript: {status.typescriptLib ?? "프로젝트 node_modules 에서 찾음 (전역 없음 — npm i -g typescript 권장)"}
        </div>
      )}
      <div className="flex items-center gap-2">
        <input
          value={path}
          onChange={(e) => setPath(e.target.value)}
          placeholder="실행 파일 경로 (비우면 PATH에서 자동으로 찾습니다)"
          className="mono min-w-0 flex-1 rounded-md border border-line bg-inset px-2.5 py-1.5 text-[11.5px] text-fg outline-none placeholder:text-muted"
          style={{ userSelect: "text" }}
          data-lsp-path={status.serverId}
        />
        <button onClick={() => void save(path.trim() || null)} className="rounded-md bg-primary px-3 py-1.5 font-medium text-on-primary hover:bg-primary-hover" data-lsp-save={status.serverId}>
          저장
        </button>
        {status.override && (
          <button onClick={() => void save(null)} className="rounded-md border border-line px-3 py-1.5 text-muted hover:bg-panel-2 hover:text-fg">
            자동으로 찾기
          </button>
        )}
      </div>
      {msg && <p className={`mono mt-2 text-[10.5px] ${msg.ok ? "text-ok" : "text-err"}`}>{msg.text}</p>}
      {status.running.length > 0 && <p className="mono mt-2 text-[10.5px] text-muted">실행 중: {status.running.join(", ")}</p>}
    </div>
  );
}

/**
 * 남아 있는 작업 사본(worktree) 정리. git 상태·크기를 재느라 몇 초 걸릴 수 있어 눌렀을 때 불러온다.
 * 열린 탭이 쓰는 것은 지울 수 없다(main 도 거부한다). 지우기 전에 한 번 더 묻고, 커밋 안 한 변경이 있으면 그 수를 알린다.
 */
function WorktreeCleanup() {
  const [list, setList] = useState<ManagedWorktreeDto[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirm, setConfirm] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const load = async () => {
    setLoading(true);
    try {
      setList(await window.workbench.worktree.listManaged());
    } finally {
      setLoading(false);
    }
  };
  const remove = async (w: ManagedWorktreeDto) => {
    setConfirm(null);
    const r = await window.workbench.worktree.removeManaged(w.path);
    setMsg(r.ok ? { ok: true, text: `지웠습니다: ${shorten(w.path)}` } : { ok: false, text: r.error });
    await load();
  };
  const size = (kb: number | null) => (kb === null ? "크기 모름" : kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)}GB` : kb >= 1024 ? `${Math.round(kb / 1024)}MB` : `${kb}KB`);
  const total = list?.reduce((n, w) => n + (w.sizeKb ?? 0), 0) ?? 0;
  return (
    <div className="mt-4 border-t border-line pt-3" data-worktree-cleanup>
      <div className="flex items-center gap-2 text-[12.5px]">
        <span className="text-muted">
          {list === null ? "남아 있는 작업 사본을 확인하고 지울 수 있습니다." : list.length === 0 ? "남아 있는 작업 사본이 없습니다." : `작업 사본 ${list.length}개 · 모두 ${size(total)}`}
        </span>
        <button onClick={() => void load()} disabled={loading} className="ml-auto rounded-md border border-line px-2.5 py-1 hover:bg-panel-2 disabled:opacity-50" data-worktree-list-load>
          {loading ? "확인 중…" : list === null ? "목록 보기" : "새로고침"}
        </button>
      </div>
      {list && list.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {list.map((w) => (
            <li key={w.path} className="flex items-center gap-3 rounded-md px-2 py-1.5 text-[12px] hover:bg-panel-2" data-worktree-row>
              <span className="min-w-0 flex-1">
                <span className="mono block truncate text-[11.5px]" title={w.path}>
                  {shorten(w.path)}
                </span>
                <span className="block truncate text-[11px] text-muted">
                  {w.branch || "브랜치 없음"} · {w.tab ? `${w.tab.title === w.branch ? "" : `${w.tab.title} `}${w.tab.open ? "(열린 탭)" : "(닫힌 탭)"}` : "탭 없음"}
                  {w.dirty > 0 && <span className="text-warn"> · 커밋 안 한 변경 {w.dirty}개</span>}
                </span>
              </span>
              <span className="mono shrink-0 text-[11px] text-muted">{size(w.sizeKb)}</span>
              {confirm === w.path ? (
                <span className="flex shrink-0 items-center gap-1.5">
                  <span className="text-[11px] text-err">{w.dirty > 0 ? `변경 ${w.dirty}개도 사라집니다` : "지울까요?"}</span>
                  <button onClick={() => void remove(w)} className="rounded-md border border-err/40 px-2 py-0.5 text-err hover:bg-err/10" data-worktree-remove-confirm>
                    삭제
                  </button>
                  <button onClick={() => setConfirm(null)} className="rounded-md border border-line px-2 py-0.5 hover:bg-panel">
                    취소
                  </button>
                </span>
              ) : (
                <button
                  onClick={() => setConfirm(w.path)}
                  disabled={w.openTabs > 0}
                  title={w.openTabs > 0 ? "열린 탭이 쓰고 있어 지울 수 없습니다. 탭을 닫은 뒤 지우세요." : "작업 사본과 브랜치(합쳐진 경우)를 지웁니다"}
                  className="shrink-0 rounded-md border border-line px-2 py-0.5 hover:bg-panel disabled:opacity-40"
                  data-worktree-remove
                >
                  삭제
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {msg && <div className={`mt-2 text-[11.5px] ${msg.ok ? "text-ok" : "text-err"}`}>{msg.text}</div>}
    </div>
  );
}
