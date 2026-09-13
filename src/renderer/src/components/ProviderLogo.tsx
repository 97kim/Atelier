// 제공자 로고(Claude / Codex). 정사각 webp 라 모서리만 둥글리고 크기만 받는다.
import type { Provider } from "@shared/ipc";
import claude from "../assets/claude.webp";
import codex from "../assets/codex.webp";

const SRC: Record<Provider, string> = { claude, codex };
const ALT: Record<Provider, string> = { claude: "Claude", codex: "Codex" };

export function ProviderLogo({ provider, size = 16, className = "" }: { provider: Provider; size?: number; className?: string }) {
  return (
    <img
      src={SRC[provider]}
      alt={ALT[provider]}
      width={size}
      height={size}
      draggable={false}
      className={`shrink-0 select-none object-cover ${size >= 28 ? "rounded-md" : "rounded"} ${className}`}
      style={{ width: size, height: size }}
      data-provider-logo={provider}
    />
  );
}
