import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";

export interface Series {
  key: string;
  label: string;
  color: string;
}

export interface StackedPoint {
  label: string; // x 축 라벨 (예: 9/4)
  title: string; // 툴팁 제목 (예: 2026-09-04)
  values: Record<string, number>;
  extra?: string; // 툴팁 하단 (예: $1.23)
}

/**
 * 일별 스택 막대. 얇은 막대, 세그먼트 사이 2px 여백, 위쪽만 둥글게, 은은한 그리드,
 * 마우스 오버 툴팁. 범례는 항상 표시(시리즈 2개 이상). 텍스트는 텍스트 토큰만 쓴다.
 */
export function StackedBars({
  points,
  series,
  height = 220,
  format,
}: {
  points: StackedPoint[];
  series: Series[];
  height?: number;
  format: (n: number) => string;
}) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<number | null>(null);
  const padL = 52;
  const padR = 8;
  const padT = 12;
  const padB = 26;
  const width = 800; // viewBox 기준. 실제 크기는 CSS 로 늘어난다.
  const plotW = width - padL - padR;
  const plotH = height - padT - padB;

  const totals = points.map((p) => series.reduce((a, s) => a + (p.values[s.key] ?? 0), 0));
  const max = Math.max(1, ...totals);
  const ticks = useMemo(() => niceTicks(max, 4), [max]);
  const yMax = ticks[ticks.length - 1] || max;
  const slot = plotW / Math.max(1, points.length);
  const barW = Math.max(3, Math.min(28, slot * 0.6));
  const gap = 2;
  const labelEvery = Math.max(1, Math.ceil(points.length / 10));

  return (
    <div className="relative">
      <svg viewBox={`0 0 ${width} ${height}`} className="block w-full" style={{ height }} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => {
          const y = padT + plotH - (t / yMax) * plotH;
          return (
            <g key={t}>
              <line x1={padL} x2={width - padR} y1={y} y2={y} stroke="var(--color-line)" strokeWidth={1} />
              <text x={padL - 6} y={y + 3} textAnchor="end" fontSize={10} fill="var(--color-muted)" fontFamily="var(--font-mono)">
                {tickLabel(t)}
              </text>
            </g>
          );
        })}
        {points.map((p, i) => {
          const x = padL + i * slot + (slot - barW) / 2;
          let yTop = padT + plotH;
          const segs = series
            .map((s) => ({ s, v: p.values[s.key] ?? 0 }))
            .filter(({ v }) => v > 0);
          return (
            <g key={p.title} onMouseEnter={() => setHover(i)}>
              <rect x={padL + i * slot} y={padT} width={slot} height={plotH} fill="transparent" />
              {segs.map(({ s, v }, j) => {
                const h = (v / yMax) * plotH;
                const isTop = j === segs.length - 1;
                const y = yTop - h;
                yTop = y - gap;
                const hh = Math.max(0, h - (isTop ? 0 : 0));
                return (
                  <rect
                    key={s.key}
                    x={x}
                    y={y}
                    width={barW}
                    height={hh}
                    rx={isTop ? 4 : 0}
                    fill={s.color}
                    opacity={hover === null || hover === i ? 1 : 0.55}
                  />
                );
              })}
              {i % labelEvery === 0 && (
                <text
                  x={padL + i * slot + slot / 2}
                  y={height - 8}
                  textAnchor="middle"
                  fontSize={10}
                  fill="var(--color-muted)"
                  fontFamily="var(--font-mono)"
                >
                  {p.label}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {hover !== null && points[hover] && (
        <div
          className="pointer-events-none absolute top-2 rounded-md border border-line bg-panel px-3 py-2 shadow-lg"
          style={{ left: `${Math.min(88, Math.max(2, ((padL + hover * slot) / width) * 100))}%` }}
        >
          <div className="mono mb-1 text-[10px] text-muted">{points[hover].title}</div>
          {series.map((s) => (
            <div key={s.key} className="flex items-center gap-2 text-[11px]">
              <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
              <span className="w-16 text-muted">{s.label}</span>
              <span className="mono ml-auto">{format(points[hover].values[s.key] ?? 0)}</span>
            </div>
          ))}
          <div className="mono mt-1 border-t border-line pt-1 text-[11px]">
            {t("usage.chart.total")} {format(totals[hover])}
            {points[hover].extra ? ` · ${points[hover].extra}` : ""}
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-4 text-[11px] text-muted">
        {series.map((s) => (
          <span key={s.key} className="inline-flex items-center gap-1.5">
            <span className="h-2 w-2 rounded-sm" style={{ background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
    </div>
  );
}

/** 축 눈금은 짧게: 800M, 1.5B, 20k. */
function tickLabel(n: number): string {
  const f = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1).replace(/\.0$/, ""));
  if (n >= 1e9) return `${f(n / 1e9)}B`;
  if (n >= 1e6) return `${f(n / 1e6)}M`;
  if (n >= 1e3) return `${f(n / 1e3)}k`;
  return String(n);
}

function niceTicks(max: number, count: number): number[] {
  if (max <= 0) return [0];
  const raw = max / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const norm = raw / mag;
  const step = (norm <= 1 ? 1 : norm <= 2 ? 2 : norm <= 5 ? 5 : 10) * mag;
  const out: number[] = [];
  for (let v = 0; v <= max + step * 0.999; v += step) out.push(Math.round(v * 1e6) / 1e6);
  return out;
}
