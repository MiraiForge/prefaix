import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const releaseTag =
  process.env.GITHUB_EVENT_NAME === "push" &&
  /^refs\/tags\/v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(
    process.env.GITHUB_REF ?? "",
  ) &&
  process.env.GITHUB_REF === `refs/tags/v${manifest.version}`;

if (manifest.private !== true && !releaseTag) {
  console.error(
    "package.json must set private: true outside a push of its matching vX.Y.Z release tag.",
  );
  process.exitCode = 1;
} else {
  console.info(
    manifest.private === true
      ? "Package privacy guard passed: private is true."
      : "Package privacy guard passed: matching release tag (publishing still requires Allan's approval).",
  );
}
