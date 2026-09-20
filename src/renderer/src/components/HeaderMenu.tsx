// 헤더의 "더보기" 메뉴. 자주 쓰지 않는 시작 동작(팬아웃·교차 리뷰·오케스트레이션·터미널로 이어가기)을 여기 담는다.
// 헤더가 overflow-hidden 이라 VerifyPopover 와 같이 body 포털 + fixed 로 그린다.
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Icon, type IconName } from "./Icon";

export interface HeaderMenuItem {
  key: string;
  label: string;
  /** 무엇을 하는지 한 줄. 버튼 툴팁으로만 쓰던 설명을 메뉴에서는 보이게 둔다. */
  hint: string;
  icon: IconName;
  disabled?: boolean;
  /** 못 쓰는 이유(있으면 설명 대신 보여 준다). */
  disabledReason?: string;
  onSelect: () => void;
}

export function HeaderMenu({
  anchor,
  items,
  onClose,
}: {
  anchor: HTMLElement | null;
  items: HeaderMenuItem[];
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number }>({ top: 72, right: 16 });
  useLayoutEffect(() => {
    const place = () => {
      const r = anchor?.getBoundingClientRect();
      if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
    };
    place();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [anchor]);
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (!ref.current || ref.current.contains(e.target as Node)) return;
      // 여는 버튼 위의 mousedown 까지 바깥으로 치면 여기서 닫고, 이어서 오는 click 이 다시 연다 —
      // 버튼이 토글로 동작하지 않고 계속 열린 채로 보인다. 그 자리는 넘기고 버튼의 토글에 맡긴다.
      if (anchor?.contains(e.target as Node)) return;
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose, anchor]);

  return createPortal(
    <div
      ref={ref}
      className="fixed z-50 w-[260px] overflow-hidden rounded-lg border border-line bg-panel p-1 shadow-2xl"
      style={{ top: pos.top, right: pos.right }}
      data-header-menu
    >
      {items.map((it) => (
        <button
          key={it.key}
          disabled={it.disabled}
          onClick={() => {
            onClose();
            it.onSelect();
          }}
          className="flex w-full items-start gap-2.5 rounded-md px-2.5 py-2 text-left hover:bg-panel-2 disabled:opacity-40 disabled:hover:bg-transparent"
          title={it.disabled ? (it.disabledReason ?? "") : it.hint}
          data-header-menu-item={it.key}
        >
          <Icon name={it.icon} size={12} className="mt-0.5 shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block font-medium">{it.label}</span>
            <span className="mt-0.5 block text-[10.5px] leading-[1.45] text-muted">
              {it.disabled ? (it.disabledReason ?? it.hint) : it.hint}
            </span>
          </span>
        </button>
      ))}
    </div>,
    document.body,
  );
}
