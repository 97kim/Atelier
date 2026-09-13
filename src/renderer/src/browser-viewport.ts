// 브라우저 탭의 보기 폭 프리셋. 웹 작업에서 "좁은 화면에서 안 깨지나" 를 보려면 창을 줄이는 것 말고 방법이 없었다.
// 실제 창을 건드리지 않고 <webview> 만 그 폭으로 좁혀 가운데 둔다.

export interface Viewport {
  id: string;
  label: string;
  /** null 이면 패널을 꽉 채운다. */
  width: number | null;
  hint: string;
}

export const VIEWPORTS: Viewport[] = [
  { id: "full", label: "전체", width: null, hint: "패널을 꽉 채운다" },
  { id: "phone", label: "폰", width: 390, hint: "390px — iPhone 세로" },
  { id: "tablet", label: "태블릿", width: 834, hint: "834px — iPad 세로" },
  { id: "desktop", label: "데스크톱", width: 1280, hint: "1280px — 좁은 노트북" },
];

export const DEFAULT_VIEWPORT = "full";

export function viewportById(id: string): Viewport {
  return VIEWPORTS.find((v) => v.id === id) ?? VIEWPORTS[0];
}

/** 확대 배율(%) ↔ Electron 의 zoomLevel. level = log(ratio)/log(1.2) */
export function zoomLevelToPercent(level: number): number {
  return Math.round(Math.pow(1.2, level) * 100);
}

export const ZOOM_STEPS = [-3, -2, -1, 0, 1, 2, 3, 4] as const;

/** 지금 배율에서 한 칸 올리거나 내린 zoomLevel. 범위를 벗어나면 그대로. */
export function nextZoom(level: number, dir: 1 | -1): number {
  const i = ZOOM_STEPS.indexOf(Math.round(level) as (typeof ZOOM_STEPS)[number]);
  const at = i === -1 ? ZOOM_STEPS.indexOf(0) : i;
  return ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, at + dir))];
}
