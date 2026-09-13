// 변경 파일 목록 + 커밋 폼 상태. 컨텍스트 패널의 "변경 파일" 섹션과 변경 리뷰 오버레이가 같은 상태를 공유한다.
import { useCallback, useEffect, useState } from "react";
import type { GitChangeDto, GitInfoDto } from "@shared/ipc";

export interface GitChangesState {
  git: GitInfoDto | null;
  changes: GitChangeDto[];
  selected: Set<string>;
  selectedPaths: string[];
  toggle(path: string): void;
  selectAll(on: boolean): void;
  message: string;
  setMessage(v: string): void;
  busy: "draft" | "commit" | "revert" | null;
  result: { ok: boolean; text: string } | null;
  draft(): Promise<void>;
  commit(): Promise<void>;
  /** 파일 하나의 변경을 버린다. 성공하면 목록을 새로 읽는다. */
  revert(path: string): Promise<void>;
  refresh(): void;
}

export function useGitChanges(cwd: string | null, refreshDep: string | number | boolean | null): GitChangesState {
  const [git, setGit] = useState<GitInfoDto | null>(null);
  const [changes, setChanges] = useState<GitChangeDto[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState<GitChangesState["busy"]>(null);
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const refresh = useCallback(() => setRefreshKey((k) => k + 1), []);
  // 밖에서(터미널 커밋, 에이전트 편집, 에디터 저장) 바뀐 것도 따라오게: 창이 포커스를 얻을 때와 5초마다 다시 읽는다.
  useEffect(() => {
    if (!cwd) return;
    const onFocus = () => refresh();
    window.addEventListener("focus", onFocus);
    // 창이 뒤에 있으면 폴링을 멈춘다(git 프로세스 낭비 방지)
    const t = setInterval(() => {
      if (!document.hidden) refresh();
    }, 5000);
    return () => {
      window.removeEventListener("focus", onFocus);
      clearInterval(t);
    };
  }, [cwd, refresh]);

  useEffect(() => {
    if (!cwd) {
      setGit(null);
      setChanges([]);
      return;
    }
    let alive = true;
    // 내용이 같으면 상태를 바꾸지 않는다 — 5초 폴링이 리뷰 오버레이의 diff 를 매번 다시 읽게 하지 않도록.
    window.workbench.git.info(cwd).then((g) => alive && setGit((prev) => (sameJson(prev, g) ? prev : g)));
    window.workbench.git.changes(cwd).then((c) => {
      if (!alive) return;
      setChanges((prevChanges) => {
        if (sameJson(prevChanges, c)) return prevChanges;
        // 새로 나타난 파일은 기본으로 고르고, 사라진 파일은 선택에서 뺀다.
        const known = new Set(prevChanges.map((x) => x.path));
        setSelected((prev) => {
          const next = new Set<string>();
          for (const x of c) if (!known.has(x.path) || prev.has(x.path)) next.add(x.path);
          return next;
        });
        return c;
      });
    });
    return () => {
      alive = false;
    };
  }, [cwd, refreshKey, refreshDep]);

  const selectedPaths = changes.filter((c) => selected.has(c.path)).map((c) => c.path);
  const toggle = (path: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const selectAll = (on: boolean) => setSelected(on ? new Set(changes.map((c) => c.path)) : new Set());

  const draft = async () => {
    if (!cwd || selectedPaths.length === 0) return;
    setBusy("draft");
    setResult(null);
    const r = await window.workbench.git.draftMessage(cwd, selectedPaths);
    setBusy(null);
    if (r.ok) setMessage(r.message);
    else setResult({ ok: false, text: r.error });
  };
  const commit = async () => {
    if (!cwd || selectedPaths.length === 0 || !message.trim()) return;
    setBusy("commit");
    setResult(null);
    const r = await window.workbench.git.commit(cwd, selectedPaths, message);
    setBusy(null);
    if (r.ok) {
      setMessage("");
      setResult({ ok: true, text: `${r.hash} · ${r.files}개 파일 커밋됨` });
      refresh();
    } else setResult({ ok: false, text: r.error });
  };
  const revert = async (path: string) => {
    if (!cwd) return;
    setBusy("revert");
    setResult(null);
    const r = await window.workbench.git.revert(cwd, path);
    setBusy(null);
    if (r.ok) {
      setResult({ ok: true, text: `${path} 되돌림` });
      refresh();
    } else setResult({ ok: false, text: r.error });
  };

  return {
    git, changes, selected, selectedPaths, toggle, selectAll,
    message, setMessage, busy, result, draft, commit, revert, refresh,
  };
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
