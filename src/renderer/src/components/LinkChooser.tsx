// 링크를 어디서 열지 고르는 팝업 — 답변 속 링크와 터미널 속 URL 이 같이 쓴다. 바깥 클릭·Esc 로 닫힌다.

import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Icon } from "./Icon";

export function LinkChooser({
  href,
  x,
  y,
  onDecide,
  onClose,
}: {
  href: string;
  x: number;
  y: number;
  /** remember 가 true 면 다음부터 묻지 않는다(호출자가 setLinkOpenMode). */
  onDecide: (where: "app" | "external", remember: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  useEffect(() => {
    const close = (ev: Event) => {
      if (ev instanceof KeyboardEvent && ev.key !== "Escape") return;
      onClose();
    };
    // 팝업 안 클릭은 stopPropagation 으로 막히므로 window 의 mousedown 은 바깥 클릭이다
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", close);
    };
  }, [onClose]);

  // 화면 오른쪽·아래로 넘치지 않게 위치를 조금 당긴다
  const style = { left: Math.min(x, window.innerWidth - 300), top: Math.min(y, window.innerHeight - 130) };
  const [remember, setRemember] = useState(false);

  return (
    <div
      role="menu"
      className="fixed z-50 w-[288px] rounded-lg border border-line bg-panel p-1.5 shadow-xl"
      style={style}
      onMouseDown={(e) => e.stopPropagation()}
      data-link-chooser
    >
      <div className="mono truncate px-2 pb-1 pt-0.5 text-[10px] text-muted" title={href}>
        {href}
      </div>
      <button role="menuitem" onClick={() => onDecide("app", remember)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2" data-link-open-app>
        <Icon name="globe" size={12} className="text-accent" />
        <span className="flex-1">{t("chat.linkChooser.openApp")}</span>
        <span className="mono text-[10px] text-muted">{t("chat.linkChooser.altClick")}</span>
      </button>
      <button role="menuitem" onClick={() => onDecide("external", remember)} className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[12px] hover:bg-panel-2" data-link-open-external>
        <Icon name="externalLink" size={12} className="text-muted" />
        <span className="flex-1">{t("chat.linkChooser.openExternal")}</span>
        <span className="mono text-[10px] text-muted">{t("chat.linkChooser.cmdClick")}</span>
      </button>
      <label className="mt-1 flex cursor-pointer items-center gap-2 border-t border-line px-2 pb-0.5 pt-1.5 text-[11px] text-muted">
        <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} data-link-remember />
        {t("chat.linkChooser.remember")} <span className="mono text-[10px] text-muted-2">{t("chat.linkChooser.rememberHint")}</span>
      </label>
    </div>
  );
}
