import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PreviewServer } from "./preview-server";

async function get(url: string, init?: RequestInit) {
  const r = await fetch(url, init);
  return { status: r.status, type: r.headers.get("content-type"), cache: r.headers.get("cache-control"), body: await r.text() };
}

test("PreviewServer: 루트 안 파일만 토큰 경로로 서비스하고, 밖·추측 경로·심링크 탈출은 404", async () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "wb-preview-")));
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "wb-outside-")));
  mkdirSync(join(dir, "site", "css"), { recursive: true });
  writeFileSync(join(dir, "site", "index.html"), "<h1>hi</h1><link rel=stylesheet href=css/a.css>");
  writeFileSync(join(dir, "site", "css", "a.css"), "h1{color:red}");
  writeFileSync(join(dir, "한글 폴더.html"), "<p>k</p>");
  writeFileSync(join(outside, "secret.txt"), "nope");
  symlinkSync(join(outside, "secret.txt"), join(dir, "site", "leak.txt"));
  const srv = new PreviewServer();
  try {
    const url = await srv.urlFor(dir, join(dir, "site", "index.html"));
    assert.ok(url && /^http:\/\/127\.0\.0\.1:\d+\/p\/[0-9a-f]{32}\/[0-9a-f]{12}\/site\/index\.html$/.test(url), url ?? "null");
    const page = await get(url!);
    assert.equal(page.status, 200);
    assert.match(page.type ?? "", /text\/html/);
    assert.equal(page.cache, "no-store");
    assert.match(page.body, /<h1>hi<\/h1>/);
    // 상대 자원은 같은 루트에서
    const css = await get(url!.replace("index.html", "css/a.css"));
    assert.equal(css.status, 200);
    assert.match(css.type ?? "", /text\/css/);
    // 디렉토리는 index.html
    assert.equal((await get(url!.replace("/index.html", ""))).status, 200);
    // 한글 이름은 인코딩돼 나가고 풀려서 읽힌다
    const k = await srv.urlFor(dir, join(dir, "한글 폴더.html"));
    assert.ok(k?.endsWith("/" + encodeURIComponent("한글 폴더.html")));
    assert.equal((await get(k!)).body, "<p>k</p>");
    // 루트 밖 파일은 URL 자체를 안 만든다
    assert.equal(await srv.urlFor(dir, join(outside, "secret.txt")), null);
    // 루트 밖을 가리키는 심링크·.. 탈출·틀린 토큰·없는 파일
    assert.equal((await get(url!.replace("index.html", "leak.txt"))).status, 404);
    assert.equal((await get(url!.replace("site/index.html", "..%2F..%2Fetc%2Fpasswd"))).status, 404);
    assert.equal((await get(url!.replace(/\/p\/[0-9a-f]{32}\//, "/p/" + "0".repeat(32) + "/"))).status, 404);
    assert.equal((await get(url!.replace("index.html", "missing.html"))).status, 404);
    // 다른 origin 의 페이지가 보내는 요청은 거부
    assert.equal((await get(url!, { headers: { origin: "http://evil.example" } })).status, 403);
    assert.equal((await fetch(url!, { method: "POST" })).status, 405);
  } finally {
    srv.close();
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
