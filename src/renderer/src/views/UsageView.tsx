import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  Provider,
  ProviderRateLimitDto,
  RateLimitWindowDto,
  UsageSettingsDto,
  UsageStatusDto,
} from "@shared/ipc";
import {
  pctChange,
  periodRange,
  tokensTotal,
  type Period,
  type UsageFilter,
  type UsageSummary,
} from "@shared/usage";
import { Icon } from "../components/Icon";
import { StackedBars, type StackedPoint } from "../components/StackedBars";

const PERIODS: { id: Period; label: string }[] = [
  { id: "today", label: "오늘" },
  { id: "7d", label: "지난 7일" },
  { id: "30d", label: "지난 30일" },
  { id: "month", label: "이번 달" },
];

// dataviz 검증 통과 팔레트 (light, 인접 쌍 CVD ΔE ≥ 13). 입력=인디고, 캐시=틸, 출력=앰버.
const SERIES = [
  { key: "input", label: "입력", color: "#696FEA" },
  { key: "cacheRead", label: "캐시 읽기", color: "#2A9D8F" },
  { key: "output", label: "출력", color: "#C98A1E" },
];

export function UsageView() {
  const [period, setPeriod] = useState<Period>("30d");
  const [provider, setProvider] = useState<Provider | "all">("all");
  const [cwd, setCwd] = useState<string | null>(null);
  const [summary, setSummary] = useState<UsageSummary | null>(null);
  const [wsOptions, setWsOptions] = useState<{ cwd: string; name: string }[]>(
    [],
  );
  const [status, setStatus] = useState<UsageStatusDto | null>(null);
  const [settings, setSettings] = useState<UsageSettingsDto>({
    monthlyBudgetUsd: null,
  });
  const [monthCost, setMonthCost] = useState<number | null>(null);
  const [budgetInput, setBudgetInput] = useState("");
  const [exported, setExported] = useState<string | null>(null);
  const [hideCache, setHideCache] = useState(false);

  const filter = useMemo<UsageFilter>(
    () => ({ ...periodRange(period, Date.now()), provider, cwd }),
    [period, provider, cwd],
  );

  const load = useCallback(async () => {
    const [s, st, all, month, cfg] = await Promise.all([
      window.workbench.usage.query(filter),
      window.workbench.usage.status(),
      window.workbench.usage.query({ ...filter, cwd: null }),
      window.workbench.usage.query({
        ...periodRange("month", Date.now()),
        provider: "all",
      }),
      window.workbench.usage.getSettings(),
    ]);
    setSummary(s);
    setStatus(st);
    setWsOptions(all.byWorkspace.map((w) => ({ cwd: w.cwd, name: w.name })));
    setMonthCost(month.totals.costUsd);
    setSettings(cfg);
    setBudgetInput(cfg.monthlyBudgetUsd ? String(cfg.monthlyBudgetUsd) : "");
  }, [filter]);

  useEffect(() => {
    void load();
    return window.workbench.usage.onChanged(() => void load());
  }, [load]);

  const saveBudget = async () => {
    const n = Number(budgetInput);
    const next = await window.workbench.usage.setSettings({
      monthlyBudgetUsd: Number.isFinite(n) && n > 0 ? n : null,
    });
    setSettings(next);
  };

  const exportCsv = async () => {
    const p = await window.workbench.usage.exportCsv(filter);
    setExported(p);
    if (p) setTimeout(() => setExported(null), 4000);
  };

  const points: StackedPoint[] = useMemo(
    () =>
      (summary?.daily ?? []).map((d) => ({
        label: d.day.slice(5).replace("-", "/"),
        title: d.day,
        values: {
          input: d.input + d.cacheWrite,
          cacheRead: hideCache ? 0 : d.cacheRead,
          output: d.output,
        },
        extra: `$${d.costUsd.toFixed(2)} · ${d.requests}회`,
      })),
    [summary, hideCache],
  );
  const chartSeries = hideCache
    ? SERIES.filter((s) => s.key !== "cacheRead")
    : SERIES;

  const t = summary?.totals;
  const prev = summary?.previous;
  const totalTokens = t ? tokensTotal(t) : 0;
  const limits = status?.rateLimits;
  const [refreshingLimits, setRefreshingLimits] = useState(false);
  const refreshLimits = async () => {
    if (refreshingLimits) return;
    setRefreshingLimits(true);
    try {
      setStatus(await window.workbench.usage.refreshLimits());
    } finally {
      setRefreshingLimits(false);
    }
  };

  return (
    <div className="flex h-full flex-col">
      <header className="drag flex h-[84px] shrink-0 items-center justify-between px-6 pt-7">
        <div>
          <div className="text-[15px] font-semibold">사용량</div>
          <div className="text-[11px] text-muted">
            터미널·앱에서 쓴 Claude Code / Codex 토큰을 로컬 트랜스크립트에서
            합산 · 비용은 API 환산 추정
          </div>
        </div>
        <div className="no-drag mono flex items-center gap-2 text-[10px] text-muted">
          {status?.scanning
            ? "스캔 중…"
            : status?.lastScanAt
              ? `${status.files}개 파일 · ${fmtTime(status.lastScanAt)} 갱신`
              : ""}
          <button
            onClick={() => void window.workbench.usage.rescan().then(setStatus)}
            className="rounded-md border border-line p-1.5 hover:bg-panel-2"
            title="다시 스캔"
          >
            <Icon name="refresh" size={12} />
          </button>
        </div>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-4">
          {/* 필터 */}
          <div className="flex flex-wrap items-center gap-2">
            <div className="flex rounded-md border border-line bg-panel p-0.5">
              {PERIODS.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setPeriod(p.id)}
                  className={`rounded px-3 py-1 ${period === p.id ? "bg-accent-tint text-accent" : "text-muted hover:text-fg"}`}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <div className="flex rounded-md border border-line bg-panel p-0.5">
              {(["all", "claude", "codex"] as const).map((p) => (
                <button
                  key={p}
                  onClick={() => setProvider(p)}
                  className={`rounded px-3 py-1 ${provider === p ? "bg-accent-tint text-accent" : "text-muted hover:text-fg"}`}
                >
                  {p === "all" ? "전체" : p === "claude" ? "Claude" : "Codex"}
                </button>
              ))}
            </div>
            <Select
              value={cwd ?? ""}
              onChange={(v) => setCwd(v || null)}
              icon="folder"
            >
              <option value="">모든 워크스페이스</option>
              {wsOptions.map((w) => (
                <option key={w.cwd} value={w.cwd}>
                  {w.name} — {shorten(w.cwd)}
                </option>
              ))}
            </Select>
            <button
              onClick={() => void exportCsv()}
              className="ml-auto flex items-center gap-2 rounded-md border border-line bg-panel px-3 py-1.5 hover:bg-panel-2"
            >
              <Icon name="file" size={13} />
              CSV 내보내기
            </button>
          </div>
          {exported && (
            <p className="mono text-[11px] text-ok">저장됨: {exported}</p>
          )}

          {/* KPI */}
          <div className="grid grid-cols-4 gap-4">
            <Kpi
              label="총 토큰"
              value={fmtTokens(totalTokens)}
              delta={
                t && prev ? pctChange(totalTokens, tokensTotal(prev)) : null
              }
              icon="usage"
            />
            <Kpi
              label="추정 비용 (API 환산)"
              value={t ? fmtUsd(t.costUsd) : "-"}
              delta={t && prev ? pctChange(t.costUsd, prev.costUsd) : null}
              sub={
                t && t.unpricedModels.length > 0
                  ? `가격표 없음: ${t.unpricedModels.join(", ")}`
                  : undefined
              }
              icon="sparkles"
            />
            <Kpi
              label="API 요청"
              value={t ? t.requests.toLocaleString() : "-"}
              delta={t && prev ? pctChange(t.requests, prev.requests) : null}
              icon="play"
            />
            <Kpi
              label="평균 비용 / 요청"
              value={
                t && t.requests > 0 ? fmtUsd(t.costUsd / t.requests, 4) : "-"
              }
              delta={
                t && prev && t.requests > 0 && prev.requests > 0
                  ? pctChange(
                      t.costUsd / t.requests,
                      prev.costUsd / prev.requests,
                    )
                  : null
              }
              icon="clock"
            />
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4">
            {/* 시간별 사용량 */}
            <Card
              title="기간별 사용량"
              sub="일별 토큰 · 캐시 쓰기는 입력에 포함"
              action={
                <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
                  <input
                    type="checkbox"
                    checked={hideCache}
                    onChange={(e) => setHideCache(e.target.checked)}
                    className="accent-[#696FEA]"
                  />
                  캐시 읽기 제외
                </label>
              }
            >
              {points.length > 0 ? (
                <StackedBars
                  points={points}
                  series={chartSeries}
                  format={fmtTokens}
                />
              ) : (
                <p className="text-muted">데이터 없음</p>
              )}
            </Card>

            {/* 모델별 */}
            <Card
              title="모델별"
              sub={t ? `${fmtUsd(t.costUsd)} 합계` : undefined}
            >
              {summary && summary.byModel.length > 0 ? (
                <ul className="flex flex-col gap-3">
                  {summary.byModel.slice(0, 8).map((m) => {
                    const share =
                      t && t.costUsd > 0 ? m.costUsd / t.costUsd : 0;
                    return (
                      <li key={m.model}>
                        <div className="flex items-center gap-2">
                          <span
                            className={`h-2 w-2 rounded-full ${m.provider === "claude" ? "bg-[#D98A5E]" : "bg-accent"}`}
                          />
                          <span
                            className="min-w-0 flex-1 truncate font-medium"
                            title={m.model}
                          >
                            {m.label}
                            <span className="mono ml-1.5 text-[10px] font-normal text-muted">
                              {m.model}
                            </span>
                            {m.estimated && (
                              <span className="label ml-1.5 text-warn">
                                추정가
                              </span>
                            )}
                            {!m.priced && (
                              <span className="label ml-1.5 text-err">
                                가격 없음
                              </span>
                            )}
                          </span>
                          <span className="mono text-[10.5px] text-muted">
                            {fmtTokens(tokensTotal(m))} ·{" "}
                            {m.priced ? fmtUsd(m.costUsd) : "-"}
                          </span>
                        </div>
                        <div className="mt-1.5 h-1 overflow-hidden rounded-full bg-panel-2">
                          <div
                            className="h-full rounded-full bg-accent"
                            style={{ width: `${Math.max(2, share * 100)}%` }}
                          />
                        </div>
                      </li>
                    );
                  })}
                </ul>
              ) : (
                <p className="text-muted">데이터 없음</p>
              )}
            </Card>
          </div>

          <div className="grid grid-cols-[minmax(0,1fr)_360px] gap-4">
            {/* 워크스페이스별 */}
            <Card title="워크스페이스별" sub="추정 비용 상위">
              {summary && summary.byWorkspace.length > 0 ? (
                <table className="w-full table-fixed text-left">
                  <colgroup>
                    <col />
                    <col className="w-14" />
                    <col className="w-20" />
                    <col className="w-24" />
                    <col className="w-14" />
                  </colgroup>
                  <thead>
                    <tr className="label border-b border-line">
                      <th className="pb-2 font-normal">프로젝트 / 경로</th>
                      <th className="pb-2 text-right font-normal">세션</th>
                      <th className="pb-2 text-right font-normal">토큰</th>
                      <th className="pb-2 text-right font-normal">비용</th>
                      <th className="pb-2 text-right font-normal">비중</th>
                    </tr>
                  </thead>
                  <tbody>
                    {summary.byWorkspace.slice(0, 10).map((w) => (
                      <tr
                        key={w.cwd}
                        className="border-b border-line/60 last:border-0"
                      >
                        <td className="min-w-0 py-2 pr-3">
                          <button
                            onClick={() => setCwd(w.cwd)}
                            className="block w-full min-w-0 text-left hover:text-accent"
                          >
                            <span className="block truncate font-medium">
                              {w.name}
                            </span>
                            <span
                              className="mono block truncate text-[10px] text-muted"
                              title={w.cwd}
                            >
                              {shorten(w.cwd)}
                            </span>
                          </button>
                        </td>
                        <td className="mono py-2 text-right text-muted">
                          {w.sessions}
                        </td>
                        <td className="mono py-2 text-right">
                          {fmtTokens(tokensTotal(w))}
                        </td>
                        <td className="mono py-2 text-right">
                          {fmtUsd(w.costUsd)}
                        </td>
                        <td className="mono py-2 text-right text-accent">
                          {Math.round(w.share * 100)}%
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p className="text-muted">데이터 없음</p>
              )}
            </Card>

            {/* 한도 · 알림 */}
            <Card title="한도 · 알림">
              <div className="flex flex-col gap-4">
                <div>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium">
                      이번 달 예산 (추정 비용 기준)
                    </span>
                    <span className="mono text-[10.5px] text-muted">
                      {monthCost !== null ? fmtUsd(monthCost) : "-"}
                      {settings.monthlyBudgetUsd
                        ? ` / ${fmtUsd(settings.monthlyBudgetUsd)}`
                        : ""}
                    </span>
                  </div>
                  {settings.monthlyBudgetUsd && monthCost !== null && (
                    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-panel-2">
                      <div
                        className={`h-full rounded-full ${monthCost / settings.monthlyBudgetUsd >= 0.8 ? "bg-warn" : "bg-accent"}`}
                        style={{
                          width: `${Math.min(100, (monthCost / settings.monthlyBudgetUsd) * 100)}%`,
                        }}
                      />
                    </div>
                  )}
                  <div className="flex gap-2">
                    <input
                      value={budgetInput}
                      onChange={(e) => setBudgetInput(e.target.value)}
                      placeholder="예: 300"
                      inputMode="decimal"
                      className="mono min-w-0 flex-1 rounded-md border border-line bg-inset px-2.5 py-1.5 outline-none focus:border-accent/50"
                      style={{ userSelect: "text" }}
                    />
                    <button
                      onClick={() => void saveBudget()}
                      className="rounded-md border border-line px-3 py-1.5 hover:bg-panel-2"
                    >
                      저장
                    </button>
                  </div>
                  <p className="mt-1.5 text-[10.5px] text-muted">
                    80% 도달 시 한 달에 한 번 알림. 비워 두면 알림 없음.
                  </p>
                </div>

                <div className="border-t border-line pt-3">
                  <div className="mb-1 flex items-center justify-between">
                    <span className="font-medium">최근 5시간</span>
                    <span className="mono text-[10.5px] text-muted">
                      {summary
                        ? `${fmtTokens(tokensTotal(summary.last5h))} · ${fmtUsd(summary.last5h.costUsd)}`
                        : "-"}
                    </span>
                  </div>
                  <p className="text-[10.5px] text-muted">
                    앱·터미널 트랜스크립트의 토큰 합계. 구독 한도 소진율은 아래.
                  </p>
                </div>

                <RateLimitBlock
                  label="Claude Code 구독 한도"
                  color="bg-accent"
                  limit={limits?.claude ?? null}
                  hint="턴이 돌 때 갱신 · 새로고침은 /usage 로 조회 (비용 없음)"
                  onRefresh={refreshLimits}
                  refreshing={refreshingLimits}
                />
                <RateLimitBlock
                  label="Codex 구독 한도"
                  color="bg-[#2A9D8F]"
                  limit={limits?.codex ?? null}
                  hint="Codex 트랜스크립트의 rate_limits 기준 · 터미널 사용도 반영"
                  onRefresh={refreshLimits}
                  refreshing={refreshingLimits}
                />

                {summary && (
                  <div className="border-t border-line pt-3">
                    <div className="mb-1.5 font-medium">출처</div>
                    <SourceBar
                      inApp={summary.sources.inApp.costUsd}
                      terminal={summary.sources.terminal.costUsd}
                    />
                  </div>
                )}
              </div>
            </Card>
          </div>

          {summary && summary.topSessions.length > 0 && (
            <Card title="상위 세션" sub="추정 비용 기준 10개">
              <ul className="grid grid-cols-2 gap-x-6 gap-y-2">
                {summary.topSessions.map((s) => (
                  <li
                    key={s.sessionId}
                    className="flex items-center gap-2 border-b border-line/60 py-1.5"
                  >
                    <span
                      className={`label rounded px-1.5 py-0.5 ${s.inApp ? "bg-accent-tint text-accent" : "bg-panel-2 text-muted"}`}
                    >
                      {s.inApp ? "인앱" : "터미널"}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium">
                        {baseName(s.cwd) || "(경로 없음)"}
                      </span>
                      <span className="mono block truncate text-[10px] text-muted">
                        {s.model} · {s.requests}회 · {fmtTime(s.lastTs)}
                      </span>
                    </span>
                    <span className="mono text-right text-[10.5px]">
                      {fmtUsd(s.costUsd)}
                      <span className="block text-muted">
                        {fmtTokens(tokensTotal(s))}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </Card>
          )}

          <p className="mono pb-2 text-[10px] text-muted">
            비용은 모델별 단가표(USD/MTok)로 환산한 추정치입니다. 구독(OAuth)
            사용자는 실제 청구와 다릅니다. 단가는
            {status?.customPricing
              ? " userData/pricing.json 을 사용 중"
              : " 앱 기본값(userData/pricing.json 으로 교체 가능)"}{" "}
            · Codex 단가는 공식 표 미확인.
          </p>
        </div>
      </div>
    </div>
  );
}

function Card({
  title,
  sub,
  action,
  children,
}: {
  title: string;
  sub?: string;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section className="min-w-0 rounded-lg border border-line bg-panel p-4">
      <div className="mb-3 flex items-baseline justify-between gap-3">
        <h2 className="text-[14px] font-semibold">{title}</h2>
        <span className="flex items-center gap-3">
          {sub && <span className="mono text-[10px] text-muted">{sub}</span>}
          {action}
        </span>
      </div>
      {children}
    </section>
  );
}

function Kpi({
  label,
  value,
  delta,
  sub,
  icon,
}: {
  label: string;
  value: string;
  delta: number | null;
  sub?: string;
  icon: "usage" | "sparkles" | "play" | "clock";
}) {
  return (
    <div className="rounded-lg border border-line bg-panel p-4">
      <div className="mb-2 flex items-center justify-between">
        <span className="label">{label}</span>
        <Icon name={icon} size={13} className="text-accent" />
      </div>
      <div className="mono text-[24px] font-medium leading-none">{value}</div>
      <div className="mt-2 text-[10.5px] text-muted">
        {delta === null ? (
          <span>이전 기간 데이터 없음</span>
        ) : (
          <span className={delta > 0 ? "text-warn" : "text-ok"}>
            {delta > 0 ? "+" : ""}
            {delta.toFixed(1)}% vs 이전 기간
          </span>
        )}
        {sub && (
          <span className="block truncate text-err" title={sub}>
            {sub}
          </span>
        )}
      </div>
    </div>
  );
}

function SourceBar({ inApp, terminal }: { inApp: number; terminal: number }) {
  const total = inApp + terminal;
  const p = total > 0 ? (inApp / total) * 100 : 0;
  return (
    <div>
      <div className="flex h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div className="h-full bg-accent" style={{ width: `${p}%` }} />
        <div className="h-full bg-[#2A9D8F]" style={{ width: `${100 - p}%` }} />
      </div>
      <div className="mono mt-1.5 flex justify-between text-[10px] text-muted">
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-accent align-middle" />
          인앱 {fmtUsd(inApp)}
        </span>
        <span>
          <span className="mr-1 inline-block h-2 w-2 rounded-sm bg-[#2A9D8F] align-middle" />
          터미널 {fmtUsd(terminal)}
        </span>
      </div>
    </div>
  );
}

function Select({
  value,
  onChange,
  icon,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  icon: "folder";
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-flex items-center">
      <Icon
        name={icon}
        size={12}
        className="pointer-events-none absolute left-2.5 text-muted"
      />
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="max-w-[320px] rounded-md border border-line bg-panel py-1.5 pl-7 pr-7"
      >
        {children}
      </select>
      <Icon
        name="chevronDown"
        size={12}
        className="pointer-events-none absolute right-2 text-muted"
      />
    </span>
  );
}

export function fmtTokens(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  return String(Math.round(n));
}

export function fmtUsd(n: number, digits = 2): string {
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** provider 하나의 5시간/주간 창 소진율. 값이 없으면 안내만 보여 준다 (턴을 돌려야 관측된다). */
function RateLimitBlock({
  label,
  color,
  limit,
  hint,
  onRefresh,
  refreshing,
}: {
  label: string;
  color: string;
  limit: ProviderRateLimitDto | null;
  hint: string;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  return (
    <div className="border-t border-line pt-3">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="font-medium">{label}</span>
        <span className="flex items-center gap-1.5">
          <span className="mono text-[10.5px] text-muted">
            {limit ? `${fmtTime(limit.observedAt)} 기준` : "정보 없음"}
          </span>
          <button
            onClick={onRefresh}
            className={`rounded p-1 text-muted hover:bg-panel-2 hover:text-fg ${refreshing ? "animate-spin" : ""}`}
            title="구독 한도 새로고침"
            data-limits-refresh
          >
            <Icon name="refresh" size={11} />
          </button>
        </span>
      </div>
      {limit ? (
        <div className="flex flex-col gap-2">
          {limit.session && <RateLimitBar color={color} w={limit.session} />}
          {limit.weekly && (
            <RateLimitBar
              color={color}
              w={limit.weekly}
              suffix={limit.modelWeekly ? " · 전체 모델" : ""}
            />
          )}
          {limit.modelWeekly && (
            <RateLimitBar
              color={color}
              w={limit.modelWeekly}
              suffix={` · ${limit.modelWeekly.label} 전용`}
            />
          )}
          <p className="text-[10.5px] text-muted">{hint}</p>
        </div>
      ) : (
        <p className="text-[10.5px] text-muted">
          {hint} · 턴을 한 번 돌리면 표시됩니다.
        </p>
      )}
    </div>
  );
}

function RateLimitBar({
  color,
  w,
  suffix = "",
}: {
  color: string;
  w: RateLimitWindowDto;
  suffix?: string;
}) {
  const pct = Math.min(100, Math.max(0, w.usedPercent));
  const left = 100 - pct;
  return (
    <div>
      <div className="mb-1 flex items-center justify-between text-[11px]">
        <span className="text-muted">
          {fmtWindow(w.windowMinutes)} 창{suffix}
        </span>
        <span className="mono text-[10.5px] text-muted">
          {pct >= 100 ? "한도 도달" : `${Math.round(pct)}% 사용 · ${Math.round(left)}% 남음`}
          {w.resetsAt ? ` · ${fmtDateTime(w.resetsAt * 1000)} 초기화` : ""}
        </span>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-panel-2">
        <div
          className={`h-full rounded-full ${pct >= 100 ? "bg-err" : pct >= 80 ? "bg-warn" : color}`}
          style={{ width: `${pct}%` }}
        />
      </div>
    </div>
  );
}

/** 오늘이면 시:분, 아니면 월/일 시:분. 한도 초기화 시각처럼 날짜와 시각이 모두 필요한 곳에. */
function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const time = d.toLocaleTimeString("ko-KR", {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (d.toDateString() === new Date().toDateString()) return time;
  return `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  return sameDay
    ? d.toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })
    : d.toLocaleDateString("ko-KR", { month: "numeric", day: "numeric" });
}

function fmtWindow(min: number): string {
  if (min >= 1440) return `${Math.round(min / 1440)}일`;
  if (min >= 60) return `${Math.round(min / 60)}시간`;
  return `${min}분`;
}

function shorten(p: string): string {
  return p.replace(/^\/Users\/[^/]+/, "~");
}

function baseName(p: string): string {
  const parts = p.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || p;
}
