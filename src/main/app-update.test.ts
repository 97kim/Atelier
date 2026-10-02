import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brewUpgrade, caskVersion, downloadProgress, runBrew, compareVersions, fetchLatestRelease, type UpdateProgress } from "./app-update";

test("버전은 자리마다 숫자로 비교한다", () => {
  assert.ok(compareVersions("0.9.30", "0.9.29") > 0);
  assert.ok(compareVersions("0.10.0", "0.9.99") > 0);
  assert.ok(compareVersions("0.9.29", "1.0.0") < 0);
  assert.equal(compareVersions("v0.9.29", "0.9.29"), 0);
  assert.equal(compareVersions("1.0", "1.0.0"), 0);
});

const fakeFetch = (status: number, body: unknown) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

test("최신 릴리즈 태그에서 v 를 떼고 페이지 주소를 함께 준다", async () => {
  const r = await fetchLatestRelease(fakeFetch(200, { tag_name: "v0.9.30", html_url: "https://github.com/97kim/Atelier/releases/tag/v0.9.30" }));
  assert.deepEqual(r, { version: "0.9.30", url: "https://github.com/97kim/Atelier/releases/tag/v0.9.30" });
});

test("응답이 실패이거나 태그가 없으면 오류", async () => {
  await assert.rejects(fetchLatestRelease(fakeFetch(404, {})), /404/);
  await assert.rejects(fetchLatestRelease(fakeFetch(200, { name: "x" })), /버전/);
});

/** PATH 맨 앞에 가짜 brew 를 둔다. list 는 installed 버전을 답하고, 나머지 명령은 성공한다. */
function fakeBrewEnv(installed: string | null): NodeJS.ProcessEnv {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  const list = installed ? `echo "atelier ${installed}"` : "exit 1";
  writeFileSync(join(dir, "brew"), `#!/bin/sh\nif [ "$1" = list ]; then ${list}; fi\nexit 0\n`);
  chmodSync(join(dir, "brew"), 0o755);
  // 캐시도 가짜 폴더로 — 진행률을 재려고 실제 Homebrew 캐시를 읽지 않게
  return { ...process.env, PATH: `${dir}:${process.env.PATH}`, HOMEBREW_CACHE: join(dir, "cache") };
}

test("brew upgrade 가 성공해도 설치 버전이 목표에 못 미치면 실패", async () => {
  const r = await brewUpgrade(fakeBrewEnv("0.9.29"), "0.9.30");
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : "", /0\.9\.30.*0\.9\.29/);
});

test("목표 버전에 닿으면 설치 버전을 돌려준다", async () => {
  assert.deepEqual(await brewUpgrade(fakeBrewEnv("0.9.30"), "0.9.30"), { ok: true, version: "0.9.30" });
});

test("cask 로 설치하지 않았으면 caskVersion 은 null", async () => {
  assert.equal(await caskVersion(fakeBrewEnv(null)), null);
});

test("시간 초과면 다른 프로세스 그룹의 자손까지 끝낸 뒤 돌려준다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  // set -m: 백그라운드 작업이 자기 프로세스 그룹을 갖는다(Homebrew 의 pgroup: true 와 같은 상황)
  writeFileSync(join(dir, "brew"), "#!/bin/sh\nset -m\nsleep 30 &\necho $!\nwait\n");
  chmodSync(join(dir, "brew"), 0o755);
  const r = await runBrew([], { ...process.env, PATH: `${dir}:${process.env.PATH}` }, 1500, 300);
  assert.equal(r.code, null);
  assert.match(r.out, /시간 초과/);
  const pid = Number(r.out.trim().split("\n")[0]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "자손 sleep 이 남아 있다");
});

test("TERM 을 무시하는 자손이 있으면 KILL 로 끝낸 뒤 돌려준다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  // 자손은 별도 그룹 + TERM 무시 + 출력 파이프를 물지 않는다 → brew 만 먼저 끝나 close 가 온다
  writeFileSync(join(dir, "brew"), "#!/bin/sh\nset -m\nsh -c 'trap \"\" TERM; exec sleep 30' >/dev/null 2>&1 &\necho $!\nwait\n");
  chmodSync(join(dir, "brew"), 0o755);
  const r = await runBrew([], { ...process.env, PATH: `${dir}:${process.env.PATH}` }, 1500, 300);
  assert.equal(r.code, null);
  const pid = Number(r.out.trim().split("\n")[0]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "TERM 을 무시한 자손이 남아 있다");
});

/** 가짜 brew 를 시간 초과로 끊고, 출력 첫 줄의 pid 가 반환 시점에 남아 있지 않은지 본다. */
async function assertCleanedUp(script: string) {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  writeFileSync(join(dir, "brew"), `#!/bin/sh\n${script}\n`);
  chmodSync(join(dir, "brew"), 0o755);
  const r = await runBrew([], { ...process.env, PATH: `${dir}:${process.env.PATH}` }, 1500, 300);
  assert.equal(r.code, null);
  const pid = Number(r.out.trim().split("\n")[0]);
  assert.ok(pid > 0);
  assert.throws(() => process.kill(pid, 0), "남은 프로세스가 있다");
}

test("brew 자신이 TERM 을 무시해 close 가 오지 않아도 KILL 로 끝내고 돌려준다", () =>
  assertCleanedUp("trap '' TERM\necho $$\nsleep 30"));

test("TERM 을 무시하는 자손이 출력 파이프를 물고 있어도 KILL 로 끝내고 돌려준다", () =>
  assertCleanedUp("set -m\nsh -c 'trap \"\" TERM; exec sleep 30' &\necho $!\nwait"));

test("릴리즈에 붙은 DMG 의 크기를 함께 준다(진행률의 분모)", async () => {
  const r = await fetchLatestRelease(
    fakeFetch(200, { tag_name: "v0.9.30", html_url: "u", assets: [{ name: "atelier-0.9.30-arm64.dmg.blockmap", size: 10 }, { name: "atelier-0.9.30-arm64.dmg", size: 143_000_000 }] }),
  );
  assert.equal(r.dmgSize, 143_000_000);
});

test("내려받는 중인 캐시 파일로 단계와 진행률을 정한다", () => {
  const dir = mkdtempSync(join(tmpdir(), "brew-dl-"));
  assert.equal(downloadProgress(join(dir, "없는폴더"), "0.9.30", 1000), null);
  assert.equal(downloadProgress(dir, "0.9.30", 1000), null, "아직 받기 전");
  // 다른 버전의 파일은 보지 않는다
  writeFileSync(join(dir, "aaa--atelier-0.9.29-arm64.dmg"), "x");
  assert.equal(downloadProgress(dir, "0.9.30", 1000), null);
  const partial = join(dir, "bbb--atelier-0.9.30-arm64.dmg.incomplete");
  writeFileSync(partial, Buffer.alloc(430));
  assert.deepEqual(downloadProgress(dir, "0.9.30", 1000), { phase: "downloading", percent: 43 });
  assert.deepEqual(downloadProgress(dir, "0.9.30"), { phase: "downloading" }, "크기를 모르면 퍼센트 없이");
  writeFileSync(partial, Buffer.alloc(1000));
  assert.deepEqual(downloadProgress(dir, "0.9.30", 1000), { phase: "downloading", percent: 99 }, "받는 동안에는 100 을 넘기지 않는다");
  renameSync(partial, join(dir, "bbb--atelier-0.9.30-arm64.dmg"));
  assert.deepEqual(downloadProgress(dir, "0.9.30", 1000), { phase: "installing" });
});

test("업그레이드하는 동안 확인 → 내려받기(%) → 설치 순서로 알린다", async () => {
  const dir = mkdtempSync(join(tmpdir(), "fake-brew-"));
  const downloads = join(dir, "cache", "downloads");
  mkdirSync(downloads, { recursive: true });
  const f = join(downloads, "ccc--atelier-0.9.30-arm64.dmg");
  // upgrade: 반쯤 받은 파일을 잠깐 두었다가 다 받은 이름으로 바꾸고 조금 더 머문다(설치)
  writeFileSync(
    join(dir, "brew"),
    `#!/bin/sh\nif [ "$1" = list ]; then echo "atelier 0.9.30"; fi\nif [ "$1" = upgrade ]; then head -c 500 /dev/zero > "${f}.incomplete"; sleep 0.4; mv "${f}.incomplete" "${f}"; sleep 0.4; fi\nexit 0\n`,
  );
  chmodSync(join(dir, "brew"), 0o755);
  const seen: UpdateProgress[] = [];
  const r = await brewUpgrade({ ...process.env, PATH: `${dir}:${process.env.PATH}`, HOMEBREW_CACHE: join(dir, "cache") }, "0.9.30", { dmgSize: 1000, pollMs: 50, onProgress: (p) => seen.push(p) });
  assert.deepEqual(r, { ok: true, version: "0.9.30" });
  assert.deepEqual(seen, [{ phase: "checking" }, { phase: "downloading", percent: 50 }, { phase: "installing" }]);
});
