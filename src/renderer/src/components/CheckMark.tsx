// 13px 커스텀 체크 마크. 브라우저 기본 체크박스는 OS 스타일이 끼어들어 촘촘한 목록에서 크기·정렬이 맞지 않아 직접 그린다.
// interactive=false 면 표시만 하고(행 전체가 토글일 때), true 면 자체가 버튼이다.
import { Icon } from "./Icon";

export function CheckMark({
  checked,
  onToggle,
  label,
  className = "",
}: {
  checked: boolean;
  /** 주면 마크 자체가 클릭 가능한 체크박스가 된다. 없으면 표시 전용(부모 행이 토글). */
  onToggle?: () => void;
  label?: string;
  className?: string;
}) {
  const box = (
    <span
      className={`flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-[3px] border transition-colors ${
        checked ? "border-accent bg-accent text-on-accent" : "border-line bg-inset"
      } ${className}`}
      aria-hidden={onToggle ? undefined : true}
    >
      {checked && <Icon name="check" size={9} strokeWidth={3} />}
    </span>
  );
  if (!onToggle) return box;
  return (
    <button
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      className="flex shrink-0 items-center rounded p-0.5 hover:bg-panel-2"
    >
      {box}
    </button>
  );
}

/** 변경 종류 배지: 체크 마크와 시각적 무게를 맞춘 14px 정사각. */
export function KindBadge({ kind }: { kind: "added" | "modified" | "deleted" | "renamed" }) {
  const cls =
    kind === "added"
      ? "bg-ok-bg text-ok"
      : kind === "deleted"
        ? "bg-err-bg text-err"
        : "bg-warn-bg text-warn";
  return (
    <span className={`mono flex h-[14px] w-[14px] shrink-0 items-center justify-center rounded-[3px] text-[9.5px] font-semibold ${cls}`}>
      {kind[0].toUpperCase()}
    </span>
  );
}
