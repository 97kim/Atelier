import test from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { brewUpgrade, caskVersion, runBrew, compareVersions, fetchLatestRelease } from "./app-update";

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
  return { ...process.env, PATH: `${dir}:${process.env.PATH}` };
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
