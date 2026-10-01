const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function signAdhoc(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  // 패키징 때 이 Mac 에서 다시 컴파일한 node-pty 는 디버그 심볼에 빌드 경로(/Users/<이름>/...)를 품는다.
  // 공개 DMG 에 개인 경로가 실리지 않게 서명 전에 디버그 심볼만 지운다(전역 심볼은 남아 로드에 지장 없다).
  const ptyDir = path.join(appPath, "Contents/Resources/app.asar.unpacked/node_modules/node-pty");
  const natives = execFileSync("find", [ptyDir, "-type", "f", "(", "-name", "*.node", "-o", "-name", "spawn-helper", ")"], { encoding: "utf8" })
    .split("\n")
    .filter(Boolean);
  if (natives.length > 0) execFileSync("strip", ["-S", ...natives], { stdio: "inherit" });

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" }
  );

  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
};
