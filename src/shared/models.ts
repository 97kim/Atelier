// provider 별 모델 목록의 정적 폴백. 실제 목록은 main/models.ts 가 CLI 에 물어 온다(app.models). 빈 id 는 "CLI 기본 설정".
import type { ModelOptionDto, Provider } from "./ipc";

export const STATIC_MODELS: Record<Provider, ModelOptionDto[]> = {
  claude: [
    { id: "opus[1m]", label: "Opus (1M context)" },
    { id: "opus", label: "Opus" },
    { id: "sonnet", label: "Sonnet" },
    { id: "haiku", label: "Haiku" },
  ],
  codex: [
    { id: "gpt-6-astra", label: "GPT-6-Astra" },
    { id: "gpt-5.4", label: "gpt-5.4" },
  ],
};

/** 피커 옵션: 맨 앞에 "기본(CLI 설정)" 을 붙이고, 현재 값이 목록에 없으면 그대로 한 줄 더 둔다(사용자가 직접 넣은 모델명). */
export function modelOptions(models: ModelOptionDto[], current: string | undefined, defaultModel: string | null | undefined): ModelOptionDto[] {
  // CLI 설정 파일에 모델이 없으면 CLI 가 기본으로 고르는 모델(isDefault, Codex)을 "기본" 줄에 적는다
  const fallbackDefault = models.find((m) => m.isDefault)?.label;
  const shown = defaultModel || fallbackDefault;
  const head: ModelOptionDto = { id: "", label: shown ? `기본 (CLI 설정: ${shown})` : "기본 (CLI 설정)" };
  const rest = models.filter((m) => m.id !== "");
  const cur = current ?? "";
  const known = cur === "" || rest.some((m) => m.id === cur);
  return [head, ...rest, ...(known ? [] : [{ id: cur, label: `${cur} (직접 입력)` }])];
}
