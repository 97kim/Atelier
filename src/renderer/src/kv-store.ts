// 렌더러 상태의 작은 키-값 저장소. 값은 main 의 renderer-state.json 에 산다(앱 시작 때 한 번 받아 오고, 바뀌면 바로 보낸다).
// localStorage 대신 쓰는 이유: Chromium 은 localStorage 를 몇 초 늦게 디스크에 쓰므로 앱이 갑자기 죽으면 마지막 편집이 사라진다.
// 읽기는 동기(메모리), 쓰기는 main 으로 한 방향 전송. 시작 전에 hydrateKv 를 한 번 불러야 한다.

const mem = new Map<string, string>();
let writer: ((key: string, value: string | null) => void) | null = null;

/** 앱 시작(또는 테스트) 때: 저장돼 있던 항목과, 앞으로의 변경을 받을 writer 를 넣는다. */
export function hydrateKv(entries: Record<string, string>, write: (key: string, value: string | null) => void): void {
  mem.clear();
  for (const [k, v] of Object.entries(entries)) if (typeof v === "string") mem.set(k, v);
  writer = write;
}

export function kvGet(key: string): string | null {
  return mem.get(key) ?? null;
}

export function kvSet(key: string, value: string | null): void {
  if (value === null) {
    if (!mem.delete(key)) return;
  } else {
    if (mem.get(key) === value) return;
    mem.set(key, value);
  }
  try {
    writer?.(key, value);
  } catch {
    /* 전송 실패 — 메모리 값은 그대로 */
  }
}

export function kvKeys(prefix = ""): string[] {
  return [...mem.keys()].filter((k) => k.startsWith(prefix));
}
