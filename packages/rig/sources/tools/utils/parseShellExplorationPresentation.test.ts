import { describe, expect, it } from "vitest";

import { parseShellExplorationPresentation } from "./parseShellExplorationPresentation.js";

describe("parseShellExplorationPresentation", () => {
    it("classifies guarded reads followed by a filtered file listing", () => {
        expect(
            parseShellExplorationPresentation(
                "sed -n '1,260p' packages/rig/sources/main.ts 2>/dev/null || true; " +
                    "sed -n '1,280p' packages/rig/sources/daemon/runDaemon.ts 2>/dev/null || true; " +
                    "find packages/rig/sources -maxdepth 2 -type f | " +
                    "rg '/(daemon|server|config|paths|sandbox)/' | sort",
            ),
        ).toEqual({
            type: "exploration",
            operations: [
                { kind: "read", name: "main.ts" },
                { kind: "read", name: "runDaemon.ts" },
                { kind: "list", target: "sources" },
                {
                    command: "rg '/(daemon|server|config|paths|sandbox)/'",
                    kind: "search",
                    query: "/(daemon|server|config|paths|sandbox)/",
                },
            ],
        });
    });

    it("classifies a compound Codex shell exploration in execution order", () => {
        expect(
            parseShellExplorationPresentation(
                "rg --files src | head -n 20; rg -n 'needle value' src; sed -n '1,20p' src/example.ts",
            ),
        ).toEqual({
            type: "exploration",
            operations: [
                { kind: "list", target: "src" },
                {
                    command: "rg -n 'needle value' src",
                    kind: "search",
                    path: "src",
                    query: "needle value",
                },
                { kind: "read", name: "example.ts" },
            ],
        });
    });

    it("classifies a large, varied corpus of inspection-only shell commands", () => {
        const corpus = inspectionCorpus();
        const failures = corpus.filter(
            (command) => parseShellExplorationPresentation(command) === undefined,
        );

        expect(new Set(corpus).size).toBeGreaterThan(12_000);
        expect(corpus.join("\n")).not.toMatch(
            /(?:\/Users\/|https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|(?:token|secret|password|api[_-]?key)=)/iu,
        );
        expect(failures).toEqual([]);
    });

    it("leaves unknown and mutating shell scripts on the normal command renderer", () => {
        expect(parseShellExplorationPresentation("pnpm test")).toBeUndefined();
        expect(
            parseShellExplorationPresentation("rg -l old src | xargs sed -i 's/old/new/g'"),
        ).toBeUndefined();
        expect(parseShellExplorationPresentation("cat source.txt > copy.txt")).toBeUndefined();
        expect(parseShellExplorationPresentation("cat source.txt 2> errors.log")).toBeUndefined();
        expect(parseShellExplorationPresentation("cat source.txt 2>> errors.log")).toBeUndefined();
        expect(parseShellExplorationPresentation("cat source.txt >/dev/null")).toBeUndefined();
    });
});

function inspectionCorpus(): string[] {
    const commands: string[] = [];
    for (let index = 0; index < 128; index += 1) {
        const start = (index % 40) + 1;
        const end = start + (index % 80) + 1;
        const count = (index % 50) + 1;
        const file = `src/module-${String(index)}.ts`;
        const directory = `src/set-${String(index)}`;
        const query = `needle-${String(index)}`;
        const inspections = [
            `sed -n '${String(start)},${String(end)}p' ${file}`,
            `cat ${file}`,
            `head -n ${String(count)} ${file}`,
            `tail -n ${String(count)} ${file}`,
            `nl -ba ${file}`,
            `bat --line-range '${String(start)}:${String(end)}' ${file}`,
            `rg -n '${query}' src`,
            `grep -R -n '${query}' src`,
            `git grep -n '${query}' -- src`,
            `find src -name 'module-${String(index)}.ts'`,
            `fd 'module-${String(index)}' src`,
            `find ${directory} -maxdepth ${String((index % 4) + 1)} -type f`,
            `rg --files --glob '*.ts' ${directory}`,
            `ls -la src/module-${String(index)}`,
            `tree -L ${String((index % 4) + 1)} ${directory}`,
            `git ls-files -- ${directory}`,
        ];

        for (const inspection of inspections) {
            commands.push(
                inspection,
                `${inspection} 2>/dev/null`,
                `${inspection} 2> /dev/null || true`,
                `${inspection} 2>>/dev/null || true`,
                `${inspection} | sort`,
                `${inspection} | head -n ${String(count)}`,
            );
        }
    }
    return commands;
}
