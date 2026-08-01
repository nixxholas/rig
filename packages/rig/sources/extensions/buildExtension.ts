import { execFile } from "node:child_process";
import { access, cp, lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { Value } from "@sinclair/typebox/value";

import { ExtensionBuildError } from "./ExtensionBuildError.js";
import { fileSystemErrorSchema, type BuiltExtension, type RegisteredExtension } from "./types.js";

const require = createRequire(import.meta.url);
const MAX_COMPILER_OUTPUT_BYTES = 4 * 1024 * 1024;
const TYPE_CHECK_TIMEOUT_MS = 30_000;

export interface BuildExtensionOptions {
    nodeTypesRoot?: string;
    sdkModuleDirectory?: string;
}

export async function buildExtension(
    extension: RegisteredExtension,
    options: BuildExtensionOptions = {},
): Promise<BuiltExtension> {
    const runtimeDirectory = join(extension.directory, ".rig");
    await prepareRuntimeDirectory(runtimeDirectory);
    const buildDirectory = join(runtimeDirectory, "build");
    const sdkInstallDirectory = join(runtimeDirectory, "node_modules", "@slopus", "plugins");
    const typeBoxInstallDirectory = join(runtimeDirectory, "node_modules", "@sinclair", "typebox");
    await Promise.all([
        rm(buildDirectory, { force: true, recursive: true }),
        rm(sdkInstallDirectory, { force: true, recursive: true }),
        rm(typeBoxInstallDirectory, { force: true, recursive: true }),
    ]);
    await Promise.all([
        mkdir(buildDirectory, { recursive: true }),
        mkdir(dirname(sdkInstallDirectory), { recursive: true }),
        mkdir(dirname(typeBoxInstallDirectory), { recursive: true }),
    ]);

    const sdkModuleDirectory =
        options.sdkModuleDirectory ?? (await resolveShippedSdkModuleDirectory());
    const typeBoxModuleDirectory = dirname(dirname(dirname(require.resolve("@sinclair/typebox"))));
    await Promise.all([
        cp(sdkModuleDirectory, sdkInstallDirectory, { recursive: true }),
        cp(typeBoxModuleDirectory, typeBoxInstallDirectory, { recursive: true }),
    ]);
    await Promise.all([
        writeFile(
            join(sdkInstallDirectory, "package.json"),
            `${JSON.stringify(
                {
                    exports: {
                        ".": {
                            default: "./index.js",
                            import: "./index.js",
                            types: "./index.d.ts",
                        },
                    },
                    name: "happy-plugins",
                    type: "module",
                },
                null,
                2,
            )}\n`,
        ),
        writeFile(join(buildDirectory, "package.json"), '{\n    "type": "module"\n}\n'),
    ]);

    const nodeTypesRoot =
        options.nodeTypesRoot ?? dirname(dirname(require.resolve("@types/node/package.json")));
    const compilerConfigPath = join(runtimeDirectory, "tsconfig.json");
    await rm(compilerConfigPath, { force: true });
    await writeFile(
        compilerConfigPath,
        `${JSON.stringify(
            {
                compilerOptions: {
                    allowImportingTsExtensions: true,
                    declaration: false,
                    lib: ["ES2023", "DOM"],
                    module: "ESNext",
                    moduleResolution: "Bundler",
                    noEmitOnError: true,
                    noUncheckedIndexedAccess: true,
                    outDir: buildDirectory,
                    paths: {
                        "happy-plugins": [join(sdkInstallDirectory, "index.d.ts")],
                    },
                    resolveJsonModule: true,
                    rewriteRelativeImportExtensions: true,
                    rootDir: extension.directory,
                    skipLibCheck: true,
                    sourceMap: true,
                    strict: true,
                    target: "ES2023",
                    typeRoots: [nodeTypesRoot],
                    types: ["node"],
                    verbatimModuleSyntax: true,
                },
                files: [extension.entryPath],
            },
            null,
            2,
        )}\n`,
        { flag: "wx" },
    );
    const typeScriptPackageDirectory = dirname(require.resolve("typescript-7/package.json"));
    await runTypeScriptCompiler(
        join(typeScriptPackageDirectory, "bin", "tsc"),
        compilerConfigPath,
        extension,
    );

    const relativeEntry = relative(extension.directory, extension.entryPath);
    const builtEntryPath = join(buildDirectory, relativeEntry.replace(/\.ts$/u, ".js"));
    return {
        ...extension,
        buildDirectory,
        builtEntryPath,
        runtimeDirectory,
    };
}

async function resolveShippedSdkModuleDirectory(): Promise<string> {
    const shipped = join(dirname(fileURLToPath(import.meta.url)), "plugin-sdk");
    try {
        await access(join(shipped, "index.js"));
        return shipped;
    } catch {
        return dirname(require.resolve("happy-plugins"));
    }
}

function runTypeScriptCompiler(
    executable: string,
    configPath: string,
    extension: RegisteredExtension,
): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        execFile(
            executable,
            ["--project", configPath, "--pretty", "false"],
            {
                cwd: extension.directory,
                maxBuffer: MAX_COMPILER_OUTPUT_BYTES,
                timeout: TYPE_CHECK_TIMEOUT_MS,
            },
            (error, stdout, stderr) => {
                if (error === null) {
                    resolve();
                    return;
                }
                const diagnostics = [stdout, stderr, error.message]
                    .map((value) => value.trim())
                    .filter(Boolean)
                    .join("\n");
                reject(new ExtensionBuildError(extension.manifest.name, diagnostics));
            },
        );
    });
}

async function prepareRuntimeDirectory(directory: string): Promise<void> {
    try {
        const info = await lstat(directory);
        if (info.isSymbolicLink() || !info.isDirectory()) {
            throw new Error("The extension's .rig runtime path must be an ordinary directory.");
        }
    } catch (error) {
        if (isMissingPath(error)) {
            await mkdir(directory, { recursive: true });
            return;
        }
        throw error;
    }
}

function isMissingPath(error: unknown): boolean {
    return Value.Check(fileSystemErrorSchema, error) && error.code === "ENOENT";
}
