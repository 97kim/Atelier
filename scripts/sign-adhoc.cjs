const { execFileSync } = require("node:child_process");
const path = require("node:path");

module.exports = async function signAdhoc(context) {
  if (context.electronPlatformName !== "darwin") return;

  const productFilename = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productFilename}.app`);

  execFileSync(
    "codesign",
    ["--force", "--deep", "--sign", "-", "--timestamp=none", appPath],
    { stdio: "inherit" }
  );

  execFileSync("codesign", ["--verify", "--deep", "--strict", appPath], {
    stdio: "inherit",
  });
};
