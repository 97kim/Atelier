// t() 의 키를 한국어 사전 기준으로 검사한다.
import "i18next";
import type { Dictionary } from "./ko";

declare module "i18next" {
  interface CustomTypeOptions {
    defaultNS: "translation";
    resources: { translation: Dictionary };
    returnNull: false;
  }
}
