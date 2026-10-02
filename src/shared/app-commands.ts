// 앱이 직접 처리하는 슬래시 커맨드. CLI 로 보내지 않고 앱 UI 를 연다 — SDK 모드에서는 /model·/config 가 TUI 화면을 못 띄우기 때문.
import type { TFunction } from "i18next";
import type { SlashCommandDto } from "./slash-commands";

export type AppCommandName = "model" | "config" | "mcp";

export function appCommands(t: TFunction): (SlashCommandDto & { name: AppCommandName })[] {
  return [
    { name: "model", description: t("session.appCommand.model"), argumentHint: t("session.appCommand.modelHint") },
    { name: "config", description: t("session.appCommand.config"), argumentHint: "" },
    { name: "mcp", description: t("session.appCommand.mcp"), argumentHint: "" },
  ];
}

/** 입력이 앱 처리 커맨드면 이름과 인자(공백 정리)를 돌려준다. `/model`, `/model opus`, `/config` … 그 외는 null. */
export function parseAppCommand(text: string): { name: AppCommandName; arg: string } | null {
  const m = /^\/(model|config|mcp)(?:\s+([\s\S]*))?$/.exec(text.trim());
  if (!m) return null;
  return { name: m[1] as AppCommandName, arg: (m[2] ?? "").trim() };
}

/** CLI 가 준 목록에 앱 처리 커맨드를 앞에 합친다. 같은 이름은 앱 설명으로 바꾼다(팔레트에서 "앱에서 처리" 가 보이게). */
export function withAppCommands(t: TFunction, commands: SlashCommandDto[]): SlashCommandDto[] {
  const own = appCommands(t);
  const app = new Set<string>(own.map((c) => c.name));
  return [...own, ...commands.filter((c) => !app.has(c.name))];
}

/** `/model` 인자 → 설정할 모델 문자열. "기본"·"default"·"" 는 CLI 기본값(빈 문자열). */
export function modelFromArg(arg: string): string {
  const a = arg.trim();
  // i18n-ignore: 별칭 정규식(한국어 입력도 받는다)
  if (!a || /^(기본|default|reset)$/i.test(a)) return "";
  return a.split(/\s+/)[0];
}
