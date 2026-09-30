import { readFileSync } from "node:fs";

const manifest = JSON.parse(readFileSync("package.json", "utf8"));
const { version, private: isPrivate, name } = manifest;
if (
  name !== "@miraiforge/prefaix" ||
  isPrivate !== false ||
  !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version) ||
  version === "0.0.0" ||
  process.env.GITHUB_EVENT_NAME !== "push" ||
  process.env.GITHUB_REF !== `refs/tags/v${version}` ||
  process.env.APPROVED_RELEASE_VERSION !== version
) {
  console.error(
    "Release refused: a public manifest, matching stable tag, and explicit approval for this exact version are required.",
  );
  process.exitCode = 1;
} else {
  console.log(`Release gate passed for ${name}@${version}.`);
}
