import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const sources = {
  "bash@4.4": [
    "https://ftp.gnu.org/gnu/bash/bash-4.4.tar.gz",
    "d86b3392c1202e8ff5a423b302e6284db7f8f435ea9f39b5b1b20fd3ac36dfcb",
  ],
  "bash@5.2": [
    "https://ftp.gnu.org/gnu/bash/bash-5.2.tar.gz",
    "a139c166df7ff4471c5e0733051642ee5556c1cc8a4a78f145583c5c81ab32fb",
  ],
  "fish@3.6.4": [
    "https://github.com/fish-shell/fish-shell/releases/download/3.6.4/fish-3.6.4.tar.xz",
    "0f3f610e580de092fbe882c8aa76623ecf91bb16fdf0543241e6e90d5d4bc393",
  ],
  "fish@4.0.2": [
    "https://github.com/fish-shell/fish-shell/releases/download/4.0.2/fish-4.0.2.tar.xz",
    "6e1ecdb164285fc057b2f35acbdc20815c1623099e7bb47bbfc011120adf7e83",
  ],
};
const [shell, version, target] = process.argv.slice(2);
const source = sources[`${shell}@${version}`];
if (source === undefined || target === undefined) {
  throw new Error(
    `Usage: node scripts/install-test-shell.mjs <bash|fish> <version> <prefix>; supported: ${Object.keys(sources).join(", ")}`,
  );
}
const prefix = resolve(target);
const binary = join(prefix, "bin", shell);
if (existsSync(binary)) {
  const installed = spawnSync(binary, ["--version"], { encoding: "utf8" });
  const escapedVersion = version.replaceAll(".", "\\.");
  if (
    installed.status !== 0 ||
    !new RegExp(`version ${escapedVersion}(?:\\.|\\b)`).test(installed.stdout)
  ) {
    throw new Error(
      `The existing ${binary} is not the requested ${shell} ${version}. Use a fresh prefix.`,
    );
  }
  console.log(binary);
  process.exit(0);
}
const work = mkdtempSync(join(tmpdir(), "pfx-shell-build-"));
function run(bin, args, cwd = work, env = process.env) {
  const result = spawnSync(bin, args, { cwd, env, stdio: "inherit" });
  if (result.error || result.status !== 0) {
    throw new Error(`${bin} failed: ${result.error?.message ?? result.status}`);
  }
}
try {
  const archive = join(work, "source.tar");
  run("curl", [
    "--fail",
    "--location",
    "--retry",
    "3",
    source[0],
    "--output",
    archive,
  ]);
  const hash = createHash("sha256").update(readFileSync(archive)).digest("hex");
  if (hash !== source[1])
    throw new Error(`Source checksum mismatch for ${shell}@${version}`);
  const unpacked = join(work, "source");
  mkdirSync(unpacked);
  run("tar", ["xf", archive, "--strip-components=1", "-C", unpacked]);
  if (shell === "bash") {
    run(
      "./configure",
      [`--prefix=${prefix}`, "--without-bash-malloc"],
      unpacked,
      {
        ...process.env,
        // Old bash predates modern clang's implicit-declaration errors.
        CFLAGS:
          "-O2 -std=gnu11 -Wno-implicit-function-declaration -Wno-int-conversion -U_FORTIFY_SOURCE -D_FORTIFY_SOURCE=0",
      },
    );
    run("make", ["-j2"], unpacked);
    run("make", ["install"], unpacked);
  } else {
    if (version === "3.6.4") {
      // fish 3.6 unconditionally creates a target named `test`, which CMake 4
      // reserves. Omit only that alias; keep the shell and test targets unchanged.
      const cmakeFile = join(unpacked, "cmake/Tests.cmake");
      const cmakeSource = readFileSync(cmakeFile, "utf8");
      writeFileSync(
        cmakeFile,
        cmakeSource
          .replace(
            "cmake_policy(SET CMP0037 OLD)",
            "cmake_policy(SET CMP0037 NEW)",
          )
          .replace(
            "add_custom_target(test DEPENDS fish_run_tests)",
            "# The fish_run_tests target remains available.",
          ),
      );
      // Its reserved macro name now collides with libc++ attributes on macOS.
      // Rename only that macro, preserving the exact fallthrough annotation.
      for (const file of readdirSync(unpacked, { recursive: true })) {
        if (typeof file === "string" && /\.(?:h|cpp|in)$/.test(file)) {
          const path = join(unpacked, file);
          const original = readFileSync(path, "utf8");
          if (original.includes("__fallthrough__")) {
            writeFileSync(
              path,
              original.replaceAll("__fallthrough__", "FISH_FALLTHROUGH"),
            );
          }
        }
      }
    }
    if (version === "4.0.2" && process.platform === "darwin") {
      // New Darwin SDKs expose pipe2 but fish 4.0's pinned nix does not.
      // Select fish's existing portable pipe+fcntl branch on this platform.
      const buildRs = join(unpacked, "build.rs");
      writeFileSync(
        buildRs,
        readFileSync(buildRs, "utf8").replace(
          'Ok(target.has_symbol("pipe2"))',
          'Ok(!cfg!(target_os = "macos") && target.has_symbol("pipe2"))',
        ),
      );
    }
    const build = join(work, "build");
    run("cmake", [
      "-S",
      unpacked,
      "-B",
      build,
      `-DCMAKE_INSTALL_PREFIX=${prefix}`,
      "-DCMAKE_BUILD_TYPE=Release",
      "-DBUILD_TESTING=OFF",
      "-DBUILD_DOCS=OFF",
      "-DCMAKE_POLICY_VERSION_MINIMUM=3.5",
    ]);
    run("cmake", ["--build", build, "--parallel", "2"]);
    run("cmake", ["--install", build]);
  }
  run(binary, ["--version"]);
} finally {
  rmSync(work, { recursive: true, force: true });
}
