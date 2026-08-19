import { execFile } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";
import { promisify } from "node:util";

import { build } from "esbuild";

const execFileAsync = promisify(execFile);

await rm("dist", { force: true, recursive: true });
await mkdir("dist", { recursive: true });
await execFileAsync("tsc", ["-p", "tsconfig.build.json"]);
await build({
    banner: {
        js: 'import { createRequire as createBundleRequire } from "node:module"; const require = createBundleRequire(import.meta.url);',
    },
    bundle: true,
    entryNames: "[name]",
    entryPoints: {
        main: "sources/main.ts",
        readPackageVersion: "sources/readPackageVersion.ts",
    },
    format: "esm",
    legalComments: "none",
    outdir: "dist",
    packages: "external",
    platform: "node",
    target: "node24",
});
await cp("../../docs", "dist/docs", { recursive: true });
