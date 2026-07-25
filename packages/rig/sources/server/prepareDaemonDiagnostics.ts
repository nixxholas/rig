import { chmod, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MAX_CRASH_REPORTS = 3;
const MAX_HEAP_SNAPSHOTS = 2;
const CRASH_REPORT_PATTERN = /^report\..+\.json$/u;
const HEAP_SNAPSHOT_PATTERN = /^Heap\..+\.heapsnapshot$/u;
const REPORTS_UNAVAILABLE_FILENAME = "crash-reports-unavailable.txt";

export async function prepareDaemonDiagnostics(options: {
    heapSnapshots: boolean;
    path: string;
    supportedFlags?: ReadonlySet<string>;
}): Promise<readonly string[]> {
    await mkdir(options.path, { mode: 0o700, recursive: true });
    await chmod(options.path, 0o700);
    await Promise.all([
        pruneDiagnostics(options.path, CRASH_REPORT_PATTERN, MAX_CRASH_REPORTS - 1),
        pruneDiagnostics(options.path, HEAP_SNAPSHOT_PATTERN, MAX_HEAP_SNAPSHOTS - 1),
    ]);

    const supported = options.supportedFlags ?? process.allowedNodeEnvironmentFlags;
    const arguments_: string[] = [];
    // Older Node releases cannot redact environment credentials from reports. Fail closed there
    // instead of persisting OAuth tokens and API keys as diagnostics.
    if (supported.has("--report-exclude-env")) {
        await rm(join(options.path, REPORTS_UNAVAILABLE_FILENAME), { force: true });
        addFlag(arguments_, supported, "--report-on-fatalerror");
        addFlag(arguments_, supported, "--report-uncaught-exception");
        addFlag(arguments_, supported, "--report-compact");
        arguments_.push("--report-exclude-env");
        addFlag(arguments_, supported, "--report-exclude-network");
    } else {
        await writeFile(
            join(options.path, REPORTS_UNAVAILABLE_FILENAME),
            "Crash reports are disabled because this Node.js runtime cannot redact environment credentials. Upgrade Node.js to enable safe daemon crash reports.\n",
            { mode: 0o600 },
        );
    }
    if (supported.has("--diagnostic-dir")) arguments_.push(`--diagnostic-dir=${options.path}`);
    if (supported.has("--report-directory")) arguments_.push(`--report-directory=${options.path}`);
    if (options.heapSnapshots && supported.has("--heapsnapshot-near-heap-limit")) {
        arguments_.push("--heapsnapshot-near-heap-limit=1");
    }
    return arguments_;
}

function addFlag(arguments_: string[], supported: ReadonlySet<string>, flag: string): void {
    if (supported.has(flag)) arguments_.push(flag);
}

async function pruneDiagnostics(directory: string, pattern: RegExp, retain: number): Promise<void> {
    const names = (await readdir(directory)).filter((name) => pattern.test(name));
    const files = (
        await Promise.all(
            names.map(async (name) => {
                const path = join(directory, name);
                try {
                    const metadata = await stat(path);
                    return metadata.isFile() ? { modifiedAt: metadata.mtimeMs, path } : undefined;
                } catch {
                    return undefined;
                }
            }),
        )
    )
        .filter((file): file is { modifiedAt: number; path: string } => file !== undefined)
        .sort((left, right) => right.modifiedAt - left.modifiedAt);
    await Promise.all(files.slice(retain).map((file) => rm(file.path, { force: true })));
}
