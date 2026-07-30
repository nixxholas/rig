import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prepareDaemonDiagnostics } from "../prepareDaemonDiagnostics.js";

const roots = new Set<string>();

afterEach(async () => {
    await Promise.all([...roots].map((root) => rm(root, { force: true, recursive: true })));
    roots.clear();
});

describe("prepareDaemonDiagnostics", () => {
    it("enables bounded private fatal reports and opt-in heap snapshots", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-daemon-diagnostics-"));
        roots.add(root);
        for (const [index, name] of [
            "report.1.json",
            "report.2.json",
            "report.3.json",
            "report.4.json",
            "Heap.1.heapsnapshot",
            "Heap.2.heapsnapshot",
            "Heap.3.heapsnapshot",
        ].entries()) {
            const path = join(root, name);
            await writeFile(path, name);
            await utimes(path, index + 1, index + 1);
        }

        const arguments_ = await prepareDaemonDiagnostics({
            heapSnapshots: true,
            path: root,
            supportedFlags: new Set([
                "--diagnostic-dir",
                "--heapsnapshot-near-heap-limit",
                "--report-compact",
                "--report-exclude-env",
                "--report-exclude-network",
                "--report-on-fatalerror",
                "--report-directory",
                "--report-uncaught-exception",
            ]),
        });

        expect(arguments_).toEqual([
            "--report-on-fatalerror",
            "--report-uncaught-exception",
            "--report-compact",
            "--report-exclude-env",
            "--report-exclude-network",
            `--diagnostic-dir=${root}`,
            `--report-directory=${root}`,
            "--heapsnapshot-near-heap-limit=1",
        ]);
        expect((await stat(root)).mode & 0o777).toBe(0o700);
        expect((await readdir(root)).sort()).toEqual([
            "Heap.3.heapsnapshot",
            "report.3.json",
            "report.4.json",
        ]);
        await expect(readFile(join(root, "report.4.json"), "utf8")).resolves.toBe("report.4.json");
    });

    it("omits heap snapshots unless explicitly enabled", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-daemon-diagnostics-"));
        roots.add(root);

        const arguments_ = await prepareDaemonDiagnostics({
            heapSnapshots: false,
            path: root,
            supportedFlags: new Set([
                "--diagnostic-dir",
                "--heapsnapshot-near-heap-limit",
                "--report-directory",
            ]),
        });

        expect(arguments_).toEqual([`--diagnostic-dir=${root}`, `--report-directory=${root}`]);
        await expect(
            readFile(join(root, "crash-reports-unavailable.txt"), "utf8"),
        ).resolves.toContain("cannot redact environment credentials");
    });

    it("writes an environment-redacted report for a real uncaught daemon failure", async () => {
        const root = await mkdtemp(join(tmpdir(), "rig-daemon-diagnostics-"));
        roots.add(root);
        const arguments_ = await prepareDaemonDiagnostics({
            heapSnapshots: false,
            path: root,
        });

        const result = spawnSync(
            process.execPath,
            [...arguments_, "--eval", 'throw new Error("daemon crash marker")'],
            {
                encoding: "utf8",
                env: { ...process.env, RIG_CRASH_TEST_SECRET: "must-not-appear" },
            },
        );

        expect(result.status).not.toBe(0);
        const reportName = (await readdir(root)).find((name) => CRASH_REPORT_PATTERN.test(name));
        expect(reportName).toBeDefined();
        const report = await readFile(join(root, reportName!), "utf8");
        expect(report).toContain("daemon crash marker");
        expect(report).not.toContain("must-not-appear");
    });
});

const CRASH_REPORT_PATTERN = /^report\..+\.json$/u;
