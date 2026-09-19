// 예약 일정. 표현은 cron 하나로 통일하고, "매일 09:30" 같은 프리셋은 그 cron 을 되읽어 붙이는 이름이다.
// 문법을 둘로 두면 편집·검증·다음 시각 계산을 두 벌 유지해야 한다(오르카도 cron 하나로 저장한다).
//
// 시간대는 일정에 저장한 IANA 이름을 쓴다. 맥의 시간대를 바꿨다고 예약 시각이 따라 움직이면 안 된다.
// 계산은 UTC 순간을 후보로 잡고 그 순간의 "그 시간대 벽시계" 를 봐서 맞는지 판정한다 —
// 그래서 서머타임으로 사라진 시각은 그날 그냥 일어나지 않고, 두 번 오는 시각은 한 번만 잡는다.

/** 5칸 cron: 분 시 일 월 요일. 초는 없다(1분보다 촘촘한 예약은 이 앱의 용도가 아니다). */
export interface Cron {
  minute: Set<number>;
  hour: Set<number>;
  dayOfMonth: Set<number>;
  month: Set<number>;
  /** 0=일요일. 7도 일요일로 받는다(관례). */
  dayOfWeek: Set<number>;
  /** 일·요일 둘 다 지정되면 cron 관례상 "둘 중 하나" 다. */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const FIELD_RANGE: [number, number][] = [
  [0, 59],
  [0, 23],
  [1, 31],
  [1, 12],
  [0, 7],
];

const MONTH_NAMES = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const DAY_NAMES = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];

function named(field: number, token: string): string {
  const t = token.toLowerCase();
  if (field === 3) {
    const i = MONTH_NAMES.indexOf(t);
    if (i >= 0) return String(i + 1);
  }
  if (field === 4) {
    const i = DAY_NAMES.indexOf(t);
    if (i >= 0) return String(i);
  }
  return token;
}

/** 한 칸을 값 집합으로. 못 읽으면 null — 부르는 쪽이 "형식이 틀렸다" 로 다룬다. */
function parseField(raw: string, field: number): Set<number> | null {
  const [lo, hi] = FIELD_RANGE[field];
  const out = new Set<number>();
  for (const part of raw.split(",")) {
    const m = /^(\*|\d+|[a-zA-Z]+)(?:-(\d+|[a-zA-Z]+))?(?:\/(\d+))?$/.exec(part.trim());
    if (!m) return null;
    const step = m[3] === undefined ? 1 : Number(m[3]);
    if (!Number.isInteger(step) || step < 1) return null;
    let from: number;
    let to: number;
    if (m[1] === "*") {
      from = lo;
      to = hi;
    } else {
      from = Number(named(field, m[1]));
      to = m[2] === undefined ? (m[3] === undefined ? from : hi) : Number(named(field, m[2]));
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < lo || to > hi || from > to) return null;
    for (let v = from; v <= to; v += step) out.add(field === 4 && v === 7 ? 0 : v);
  }
  return out.size > 0 ? out : null;
}

export function parseCron(expr: string): Cron | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const fields = parts.map((p, i) => parseField(p, i));
  if (fields.some((f) => f === null)) return null;
  const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as Set<number>[];
  return {
    minute,
    hour,
    dayOfMonth,
    month,
    dayOfWeek,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

/** 그 시간대에서 본 벽시계. Intl 로 뽑는다 — 시간대 데이터를 우리가 들고 있지 않아도 된다. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  weekday: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hour12: false,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

const WEEKDAY_INDEX: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

export function wallClock(at: number, timeZone: string): WallClock {
  const parts = formatterFor(timeZone).formatToParts(new Date(at));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return {
    year: Number(get("year")),
    month: Number(get("month")),
    day: Number(get("day")),
    // 자정은 24 로 오는 환경이 있다.
    hour: Number(get("hour")) % 24,
    minute: Number(get("minute")),
    weekday: WEEKDAY_INDEX[get("weekday")] ?? 0,
  };
}

/** 이 벽시계가 일정에 맞나. 일·요일이 둘 다 지정되면 cron 관례대로 "둘 중 하나" 다. */
export function matches(cron: Cron, w: WallClock): boolean {
  if (!cron.minute.has(w.minute) || !cron.hour.has(w.hour) || !cron.month.has(w.month)) return false;
  const dom = cron.dayOfMonth.has(w.day);
  const dow = cron.dayOfWeek.has(w.weekday);
  if (cron.domRestricted && cron.dowRestricted) return dom || dow;
  if (cron.domRestricted) return dom;
  if (cron.dowRestricted) return dow;
  return true;
}

const MINUTE = 60_000;

/** 그 시간대에서 본 "몇 년 몇 월 며칠 몇 시 몇 분". 서머타임 중복 판정의 열쇠다. */
function clockKey(w: WallClock): string {
  return `${w.year}-${w.month}-${w.day} ${w.hour}:${w.minute}`;
}
/**
 * 이 순간이 "같은 벽시계의 두 번째 등장" 인가(가을 서머타임). 되감는 폭은 지역마다 달라
 * 흔한 두 가지(1시간·30분)를 본다.
 */
function isRepeatedWallClock(t: number, w: WallClock, timeZone: string): boolean {
  const key = clockKey(w);
  return clockKey(wallClock(t - 60 * MINUTE, timeZone)) === key || clockKey(wallClock(t - 30 * MINUTE, timeZone)) === key;
}

/** 이 너머는 "일어나지 않는 일정" 으로 본다(2월 30일 같은 것). */
const HORIZON_DAYS = 400;

/**
 * after 이후의 첫 실행 시각(밀리초). 없으면 null.
 * after 와 같은 분은 포함하지 않는다 — 한 번 실행한 회차를 다시 잡지 않으려고.
 */
export function nextOccurrence(cron: Cron, after: number, timeZone: string): number | null {
  // 분 경계로 올린다.
  let t = Math.floor(after / MINUTE) * MINUTE + MINUTE;
  const limit = t + HORIZON_DAYS * 24 * 60 * MINUTE;
  while (t <= limit) {
    const w = wallClock(t, timeZone);
    if (matches(cron, w)) {
      // 가을 서머타임으로 같은 벽시계가 두 번 오는 날: 두 번째 것은 건너뛴다.
      // "한 시간(또는 30분) 전이 같은 벽시계" 면 그게 두 번째 등장이다 — 시각이 여럿이어도 성립한다.
      if (!isRepeatedWallClock(t, w, timeZone)) return t;
      t += MINUTE;
      continue;
    }
    // 그날 자체가 안 맞으면 남은 분을 건너뛴다. 하루를 1440번 훑지 않으려고.
    const dayMatches =
      cron.month.has(w.month) &&
      (cron.domRestricted && cron.dowRestricted
        ? cron.dayOfMonth.has(w.day) || cron.dayOfWeek.has(w.weekday)
        : cron.domRestricted
          ? cron.dayOfMonth.has(w.day)
          : cron.dowRestricted
            ? cron.dayOfWeek.has(w.weekday)
            : true);
    // 그날이 아예 안 맞으면 남은 분을 건너뛴다. 다만 한 번에 한 시간까지만 —
    // 벽시계 자정까지의 분을 통째로 더하면 서머타임 시작일(23시간)에 하루를 넘겨
    // 다음 날 자정 예약을 통째로 놓친다(뉴욕 `0 0 * * mon` 에서 일주일을 건너뛰었다).
    const remain = 24 * 60 - (w.hour * 60 + w.minute);
    t += (dayMatches ? 1 : Math.min(remain, 60)) * MINUTE;
  }
  return null;
}

/** 화면에 쓸 이름. cron 을 되읽어 프리셋이면 그 모양으로, 아니면 "직접 지정". */
export type SchedulePreset =
  | { kind: "hourly"; minute: number }
  | { kind: "daily"; hour: number; minute: number }
  | { kind: "weekdays"; hour: number; minute: number }
  | { kind: "weekly"; hour: number; minute: number; dayOfWeek: number }
  | { kind: "custom" }
  | { kind: "invalid" };

const only = (s: Set<number>): number | null => (s.size === 1 ? (s.values().next().value as number) : null);
const isRange = (s: Set<number>, lo: number, hi: number): boolean => {
  if (s.size !== hi - lo + 1) return false;
  for (let v = lo; v <= hi; v += 1) if (!s.has(v)) return false;
  return true;
};

export function classify(expr: string): SchedulePreset {
  const c = parseCron(expr);
  if (!c) return { kind: "invalid" };
  const minute = only(c.minute);
  const hour = only(c.hour);
  const everyDayOfMonth = !c.domRestricted;
  const everyMonth = isRange(c.month, 1, 12);
  if (minute === null || !everyDayOfMonth || !everyMonth) return { kind: "custom" };
  if (hour === null) {
    return isRange(c.hour, 0, 23) && !c.dowRestricted ? { kind: "hourly", minute } : { kind: "custom" };
  }
  if (!c.dowRestricted) return { kind: "daily", hour, minute };
  if (isRange(c.dayOfWeek, 1, 5)) return { kind: "weekdays", hour, minute };
  const dow = only(c.dayOfWeek);
  return dow === null ? { kind: "custom" } : { kind: "weekly", hour, minute, dayOfWeek: dow };
}

/** 프리셋 → cron. 화면에서 고른 것을 저장할 때 쓴다. */
export function presetToCron(p: Exclude<SchedulePreset, { kind: "custom" } | { kind: "invalid" }>): string {
  switch (p.kind) {
    case "hourly":
      return `${p.minute} * * * *`;
    case "daily":
      return `${p.minute} ${p.hour} * * *`;
    case "weekdays":
      return `${p.minute} ${p.hour} * * 1-5`;
    case "weekly":
      return `${p.minute} ${p.hour} * * ${p.dayOfWeek}`;
  }
}
