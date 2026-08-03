import { describe, expect, it } from "vitest";

import type { AnyDefinedTool } from "../../types.js";
import { codexApplyPatchTool } from "../codex/apply_patch.js";
import { codexExecCommandTool } from "../codex/exec_command.js";
import { codexViewImageTool } from "../codex/view_image.js";
import { codexWriteStdinTool } from "../codex/write_stdin.js";
import { claudeBashTool } from "../claude/Bash.js";
import { claudeEditTool } from "../claude/Edit.js";
import { claudeGlobTool } from "../claude/Glob.js";
import { claudeGrepTool } from "../claude/Grep.js";
import { claudeReadTool } from "../claude/Read.js";
import { claudeTaskOutputTool } from "../claude/TaskOutput.js";
import { claudeWebFetchTool } from "../claude/WebFetch.js";
import { claudeWebSearchTool } from "../claude/WebSearch.js";
import { claudeWriteTool } from "../claude/Write.js";
import { grokGrepTool } from "../grok/grep.js";
import { grokListDirTool } from "../grok/list_dir.js";
import { grokReadFileTool } from "../grok/read_file.js";
import { grokSearchReplaceTool } from "../grok/search_replace.js";
import { grokGetCommandOrSubagentOutputTool } from "../../../tools/grok/get_command_or_subagent_output.js";
import { grokRunTerminalCommandTool } from "../../../tools/grok/run_terminal_command.js";
import { grokSendCommandInputTool } from "../../../tools/grok/send_command_input.js";
import { assembleClaudeTools } from "../claude/assembleClaudeTools.js";
import { assembleCodexTools } from "../codex/assembleCodexTools.js";

// A fake AWS access key. It must never survive into a replicated summary.
const FAKE_AWS_KEY = "AKIAIOSFODNN7EXAMPLE";

function sharedCall(tool: AnyDefinedTool, args: unknown): string {
    const fn = tool.toSharedCall;
    if (fn === undefined) throw new Error(`${tool.name} has no toSharedCall`);
    const summary = fn(args as never);
    expect(summary, `${tool.name} call summary`).toBeTypeOf("string");
    const text = summary ?? "";
    expect(text.trim().endsWith("."), `${tool.name} call ends with a period`).toBe(true);
    return text;
}

function sharedResult(tool: AnyDefinedTool, result: unknown, args: unknown = {}): string {
    const fn = tool.toSharedResult;
    if (fn === undefined) throw new Error(`${tool.name} has no toSharedResult`);
    const summary = fn(result as never, args as never);
    expect(summary, `${tool.name} result summary`).toBeTypeOf("string");
    const text = summary ?? "";
    expect(text.trim().endsWith("."), `${tool.name} result ends with a period`).toBe(true);
    return text;
}

function fileDiff(
    path: string,
    kind: "add" | "delete" | "update",
    added: number | undefined,
    deleted: number | undefined,
    leakText = "",
) {
    return {
        hunks:
            leakText === ""
                ? []
                : [
                      {
                          lines: [{ kind: "add" as const, text: leakText }],
                          newStart: 1,
                          oldStart: 1,
                      },
                  ],
        kind,
        path,
        ...(added === undefined ? {} : { added }),
        ...(deleted === undefined ? {} : { deleted }),
    };
}

describe("shared tool summaries", () => {
    describe("codex exec_command", () => {
        it("names the command in the call and never quotes output", () => {
            expect(sharedCall(codexExecCommandTool, { cmd: "pnpm test" })).toBe(
                "Ran the command `pnpm test`.",
            );
        });

        it("reports a successful exit with timing", () => {
            expect(
                sharedResult(codexExecCommandTool, {
                    output: "ok",
                    exit_code: 0,
                    wall_time_seconds: 2.42,
                }),
            ).toBe("The command exited with code 0 after 2.4 seconds.");
        });

        it("explains a failing exit without quoting stderr", () => {
            const summary = sharedResult(codexExecCommandTool, {
                output: `ModuleNotFoundError: ${FAKE_AWS_KEY}`,
                exit_code: 1,
                wall_time_seconds: 0.5,
            });
            expect(summary).toBe("The command exited with code 1 after 0.5 seconds.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("reports a still-running command", () => {
            expect(
                sharedResult(codexExecCommandTool, {
                    output: "",
                    session_id: 7,
                    wall_time_seconds: 10,
                }),
            ).toBe("The command is still running after 10.0 seconds.");
        });

        it("is disclosable", () => {
            expect(codexExecCommandTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("codex apply_patch", () => {
        it("summarizes an applied patch with file and line counts", () => {
            expect(
                sharedResult(codexApplyPatchTool, {
                    files: [
                        { kind: "update", path: "a.ts", hunks: [], added: 3, deleted: 1 },
                        { kind: "add", path: "b.ts", hunks: [], added: 5 },
                    ],
                    text: "done",
                }),
            ).toBe("Applied a patch to 2 files, adding 8 lines and deleting 1 line.");
        });

        it("explains a patch that was not applied", () => {
            expect(
                sharedResult(codexApplyPatchTool, { files: [], text: "patch not applied" }),
            ).toBe("The patch was not applied.");
        });

        it("never quotes the patch body", () => {
            const summary = sharedResult(codexApplyPatchTool, {
                files: [{ kind: "add", path: "secrets.ts", hunks: [], added: 1 }],
                text: `+const key = "${FAKE_AWS_KEY}"`,
            });
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("withholds a call summary and stays disclosable", () => {
            // The only argument is the raw diff body, so there is deliberately no call summary.
            expect(codexApplyPatchTool.toSharedCall).toBeUndefined();
            expect(codexApplyPatchTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("codex view_image", () => {
        it("names the image in the call", () => {
            expect(sharedCall(codexViewImageTool, { path: "logo.png" })).toBe(
                "Viewed the image logo.png.",
            );
        });

        it("reports a loaded image without the raw bytes", () => {
            const summary = sharedResult(codexViewImageTool, {
                image_url: `data:image/png;base64,${FAKE_AWS_KEY}`,
                detail: "high",
            });
            expect(summary).toBe("Loaded the image for viewing.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("explains a processing failure", () => {
            expect(
                sharedResult(codexViewImageTool, {
                    image_url: "image content omitted because it could not be processed",
                    detail: "high",
                }),
            ).toBe("The image could not be processed.");
        });

        it("is not disclosable", () => {
            expect(codexViewImageTool.sharedOutputDisclosable).toBe(false);
        });
    });

    describe("codex write_stdin", () => {
        it("names the session but never the keystrokes", () => {
            const summary = sharedCall(codexWriteStdinTool, {
                session_id: 4,
                chars: `export AWS=${FAKE_AWS_KEY}\n`,
            });
            expect(summary).toBe("Sent input to shell session 4.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("reports a still-running session", () => {
            expect(
                sharedResult(codexWriteStdinTool, {
                    output: "",
                    session_id: 4,
                    wall_time_seconds: 0.3,
                }),
            ).toBe("The shell command is still running.");
        });

        it("explains a failing exit without quoting output", () => {
            const summary = sharedResult(codexWriteStdinTool, {
                output: FAKE_AWS_KEY,
                exit_code: 2,
                wall_time_seconds: 0.3,
            });
            expect(summary).toBe("The shell command exited with code 2.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("is disclosable", () => {
            expect(codexWriteStdinTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude Bash", () => {
        it("names the command", () => {
            expect(sharedCall(claudeBashTool, { command: "ls -la" })).toBe(
                "Ran the command `ls -la`.",
            );
        });

        it("reports a clean exit", () => {
            expect(
                sharedResult(claudeBashTool, {
                    stdout: "ok",
                    stderr: "",
                    exitCode: 0,
                    timedOut: false,
                }),
            ).toBe("The command exited with code 0.");
        });

        it("explains a failing exit without quoting output", () => {
            const summary = sharedResult(claudeBashTool, {
                stdout: FAKE_AWS_KEY,
                stderr: FAKE_AWS_KEY,
                exitCode: 1,
                timedOut: false,
            });
            expect(summary).toBe("The command exited with code 1.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("explains a timeout and a background handoff", () => {
            expect(
                sharedResult(claudeBashTool, {
                    stdout: "",
                    stderr: "",
                    exitCode: null,
                    timedOut: true,
                }),
            ).toBe("The command timed out.");
            expect(
                sharedResult(claudeBashTool, {
                    backgroundTaskId: "3",
                    stdout: "",
                    stderr: "",
                    exitCode: null,
                    timedOut: false,
                }),
            ).toBe("The command is still running in the background.");
        });

        it("is disclosable", () => {
            expect(claudeBashTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude Read", () => {
        it("names the path and range in the call", () => {
            expect(
                sharedCall(claudeReadTool, { file_path: "src/index.ts", offset: 10, limit: 50 }),
            ).toBe("Read up to 50 lines of src/index.ts starting at line 10.");
            expect(sharedCall(claudeReadTool, { file_path: "src/index.ts" })).toBe(
                "Read src/index.ts.",
            );
        });

        it("reports lines read without quoting file contents", () => {
            const summary = sharedResult(
                claudeReadTool,
                {
                    path: "/repo/src/index.ts",
                    content: `1\tconst key = "${FAKE_AWS_KEY}"`,
                    startLine: 1,
                    totalLines: 240,
                    returnedLines: 240,
                    truncated: false,
                },
                { file_path: "src/index.ts" },
            );
            expect(summary).toBe("Read 240 lines of /repo/src/index.ts.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("explains an unreadable file", () => {
            expect(
                sharedResult(
                    claudeReadTool,
                    { text: "Jupyter notebooks are not supported." },
                    { file_path: "notebook.ipynb" },
                ),
            ).toBe("Could not read notebook.ipynb as text.");
        });

        it("is disclosable", () => {
            expect(claudeReadTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude Write", () => {
        it("names the path in the call", () => {
            expect(sharedCall(claudeWriteTool, { file_path: "out.txt" })).toBe("Wrote out.txt.");
        });

        it("reports a created file without quoting contents", () => {
            const summary = sharedResult(claudeWriteTool, {
                fileDiff: fileDiff("/repo/out.txt", "add", 1, 0, FAKE_AWS_KEY),
                text: `File created successfully at: /repo/out.txt`,
            });
            expect(summary).toBe("Created /repo/out.txt with 1 line.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("reports an updated file with added and deleted counts", () => {
            expect(
                sharedResult(claudeWriteTool, {
                    fileDiff: fileDiff("/repo/out.txt", "update", 3, 2),
                    text: "File updated successfully at: /repo/out.txt",
                }),
            ).toBe("Updated /repo/out.txt, adding 3 lines and deleting 2 lines.");
        });

        it("is disclosable", () => {
            expect(claudeWriteTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude Edit", () => {
        it("names the path in the call", () => {
            expect(sharedCall(claudeEditTool, { file_path: "a.ts" })).toBe("Edited a.ts.");
        });

        it("reports the replacement count without quoting the replaced text", () => {
            const summary = sharedResult(claudeEditTool, {
                path: "/repo/a.ts",
                replacements: 1,
                fuzzy: false,
                oldString: FAKE_AWS_KEY,
                newString: `redacted-${FAKE_AWS_KEY}`,
                fileDiff: fileDiff("/repo/a.ts", "update", 1, 1, FAKE_AWS_KEY),
            });
            expect(summary).toBe("Made 1 replacement in /repo/a.ts.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("pluralizes multiple replacements", () => {
            expect(
                sharedResult(claudeEditTool, {
                    path: "/repo/a.ts",
                    replacements: 3,
                    fuzzy: false,
                    oldString: "x",
                    newString: "y",
                    fileDiff: fileDiff("/repo/a.ts", "update", 3, 3),
                }),
            ).toBe("Made 3 replacements in /repo/a.ts.");
        });

        it("is disclosable", () => {
            expect(claudeEditTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude Glob", () => {
        it("names the pattern in the call", () => {
            expect(sharedCall(claudeGlobTool, { pattern: "**/*.ts" })).toBe(
                'Searched for files matching "**/*.ts".',
            );
            expect(sharedCall(claudeGlobTool, { pattern: "*.ts", path: "src" })).toBe(
                'Searched src for files matching "*.ts".',
            );
        });

        it("reports the file count and handles the empty result", () => {
            expect(
                sharedResult(claudeGlobTool, {
                    text: `/repo/${FAKE_AWS_KEY}.ts`,
                    numFiles: 1,
                    truncated: false,
                }),
            ).toBe("Found 1 file.");
            expect(
                sharedResult(claudeGlobTool, {
                    text: "No files found",
                    numFiles: 0,
                    truncated: false,
                }),
            ).toBe("Found no matching files.");
        });

        it("never quotes the listed paths", () => {
            const summary = sharedResult(claudeGlobTool, {
                text: `/repo/${FAKE_AWS_KEY}.ts`,
                numFiles: 1,
                truncated: false,
            });
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("is disclosable", () => {
            expect(claudeGlobTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude Grep", () => {
        it("names the pattern and path in the call", () => {
            expect(sharedCall(claudeGrepTool, { pattern: "TODO" })).toBe('Searched for "TODO".');
            expect(sharedCall(claudeGrepTool, { pattern: "TODO", path: "src" })).toBe(
                'Searched src for "TODO".',
            );
        });

        it("reports a match count without quoting matched lines", () => {
            const summary = sharedResult(claudeGrepTool, {
                text: `config.ts:1:const key = "${FAKE_AWS_KEY}"\nother.ts:2:x`,
            });
            expect(summary).toBe("Found 2 matching lines.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("explains an empty search", () => {
            expect(sharedResult(claudeGrepTool, { text: "No matches found" })).toBe(
                "Found no matches.",
            );
        });

        it("is disclosable", () => {
            expect(claudeGrepTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude WebFetch", () => {
        it("names the URL in the call", () => {
            expect(sharedCall(claudeWebFetchTool, { url: "https://example.com" })).toBe(
                "Fetched https://example.com.",
            );
        });

        it("reports the size and status without quoting the page", () => {
            const summary = sharedResult(claudeWebFetchTool, {
                bytes: 2048,
                code: 200,
                codeText: "OK",
                result: `body ${FAKE_AWS_KEY}`,
                durationMs: 120,
                url: "https://example.com",
            });
            expect(summary).toBe("Fetched 2.0 KB with HTTP 200 OK.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("explains an HTTP failure", () => {
            expect(
                sharedResult(claudeWebFetchTool, {
                    bytes: 0,
                    code: 404,
                    codeText: "Not Found",
                    result: "",
                    durationMs: 30,
                    url: "https://example.com/missing",
                }),
            ).toBe("The fetch failed with HTTP 404 Not Found.");
        });

        it("is disclosable", () => {
            expect(claudeWebFetchTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude WebSearch", () => {
        it("names the query in the call", () => {
            expect(sharedCall(claudeWebSearchTool, { query: "rig privacy" })).toBe(
                'Searched the web for "rig privacy".',
            );
        });

        it("reports the result count without quoting titles or URLs", () => {
            const summary = sharedResult(claudeWebSearchTool, {
                query: "rig privacy",
                results: [
                    {
                        tool_use_id: "1",
                        content: [
                            { title: FAKE_AWS_KEY, url: `https://x/${FAKE_AWS_KEY}` },
                            { title: "Two", url: "https://y" },
                        ],
                    },
                    `commentary ${FAKE_AWS_KEY}`,
                ],
                durationSeconds: 1.2,
            });
            expect(summary).toBe("Found 2 search results.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("handles a single result", () => {
            expect(
                sharedResult(claudeWebSearchTool, {
                    query: "q",
                    results: [{ tool_use_id: "1", content: [{ title: "T", url: "https://x" }] }],
                    durationSeconds: 0.5,
                }),
            ).toBe("Found 1 search result.");
        });

        it("is disclosable", () => {
            expect(claudeWebSearchTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("claude TaskOutput", () => {
        it("names the task in the call", () => {
            expect(sharedCall(claudeTaskOutputTool, { task_id: "5" })).toBe(
                "Checked the output of background task 5.",
            );
        });

        it("reports readiness without quoting captured output", () => {
            const summary = sharedResult(claudeTaskOutputTool, {
                retrieval_status: "success",
                task: {
                    command: "echo",
                    description: "echo",
                    exitCode: 0,
                    output: FAKE_AWS_KEY,
                    status: "completed",
                    task_id: "5",
                    task_type: "local_bash",
                },
            });
            expect(summary).toBe("The background task's output is ready.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("explains a task still running after the wait", () => {
            expect(
                sharedResult(claudeTaskOutputTool, {
                    retrieval_status: "timeout",
                    task: {
                        agentId: "a1",
                        output: "",
                        path: "/root/a1",
                        status: "running",
                        task_type: "local_agent",
                    },
                }),
            ).toBe("The background agent is still running after the wait.");
        });

        it("is disclosable", () => {
            expect(claudeTaskOutputTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("grok read_file", () => {
        it("names the path in the call", () => {
            expect(sharedCall(grokReadFileTool, { target_file: "src/a.ts", limit: 20 })).toBe(
                "Read up to 20 lines of src/a.ts.",
            );
        });

        it("reports lines read without quoting contents", () => {
            const summary = sharedResult(grokReadFileTool, {
                path: "/repo/src/a.ts",
                content: `1\t${FAKE_AWS_KEY}`,
                startLine: 1,
                totalLines: 1,
                returnedLines: 1,
                truncated: false,
            });
            expect(summary).toBe("Read 1 line of /repo/src/a.ts.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("is disclosable", () => {
            expect(grokReadFileTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("grok grep", () => {
        it("reports a match count and empty search without quoting matches", () => {
            const summary = sharedResult(grokGrepTool, {
                text: `a.ts:1:${FAKE_AWS_KEY}`,
            });
            expect(summary).toBe("Found 1 matching line.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
            expect(sharedResult(grokGrepTool, { text: "No matches found" })).toBe(
                "Found no matches.",
            );
        });

        it("names the pattern and is disclosable", () => {
            expect(sharedCall(grokGrepTool, { pattern: "TODO", path: "src" })).toBe(
                'Searched src for "TODO".',
            );
            expect(grokGrepTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("grok list_dir", () => {
        it("names the directory in the call", () => {
            expect(sharedCall(grokListDirTool, { target_directory: "src" })).toBe(
                "Listed the directory src.",
            );
        });

        it("reports the entry count and empty directory without quoting names", () => {
            const summary = sharedResult(grokListDirTool, {
                text: `${FAKE_AWS_KEY}\nreadme.md`,
            });
            expect(summary).toBe("Found 2 entries.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
            expect(sharedResult(grokListDirTool, { text: "(empty directory)" })).toBe(
                "The directory is empty.",
            );
        });

        it("is disclosable", () => {
            expect(grokListDirTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("grok search_replace", () => {
        it("names the path and reports replacements without quoting text", () => {
            expect(sharedCall(grokSearchReplaceTool, { file_path: "a.ts" })).toBe("Edited a.ts.");
            const summary = sharedResult(grokSearchReplaceTool, {
                path: "/repo/a.ts",
                replacements: 2,
                fuzzy: false,
                oldString: FAKE_AWS_KEY,
                newString: "redacted",
                fileDiff: fileDiff("/repo/a.ts", "update", 2, 2, FAKE_AWS_KEY),
            });
            expect(summary).toBe("Made 2 replacements in /repo/a.ts.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("is disclosable", () => {
            expect(grokSearchReplaceTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("grok run_terminal_command", () => {
        it("names the command", () => {
            expect(sharedCall(grokRunTerminalCommandTool, { command: "make build" })).toBe(
                "Ran the command `make build`.",
            );
        });

        it("reports completion and background handoff without quoting output", () => {
            const finished = sharedResult(grokRunTerminalCommandTool, { text: FAKE_AWS_KEY });
            expect(finished).toBe("The command finished.");
            expect(finished).not.toContain(FAKE_AWS_KEY);
            const background = sharedResult(grokRunTerminalCommandTool, {
                text: `${FAKE_AWS_KEY} ...`,
                task_id: "9",
            });
            expect(background).toBe("The command is still running in the background.");
            expect(background).not.toContain(FAKE_AWS_KEY);
        });

        it("is disclosable", () => {
            expect(grokRunTerminalCommandTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("grok get_command_or_subagent_output", () => {
        it("reports how many tasks were checked without quoting output", () => {
            expect(sharedCall(grokGetCommandOrSubagentOutputTool, { task_ids: ["1", "2"] })).toBe(
                "Checked 2 background tasks.",
            );
            const summary = sharedResult(grokGetCommandOrSubagentOutputTool, {
                results: [
                    { task_id: "1", status: "completed", exit_code: 0, output: FAKE_AWS_KEY },
                ],
            });
            expect(summary).toBe("Retrieved the status of 1 background task.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("is disclosable", () => {
            expect(grokGetCommandOrSubagentOutputTool.sharedOutputDisclosable).toBe(true);
        });
    });

    describe("grok send_command_input", () => {
        it("names the task but never the keystrokes", () => {
            const summary = sharedCall(grokSendCommandInputTool, {
                task_id: "9",
                input: `export AWS=${FAKE_AWS_KEY}\n`,
            });
            expect(summary).toBe("Sent input to background command 9.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("explains a failing exit without quoting output", () => {
            const summary = sharedResult(grokSendCommandInputTool, {
                exit_code: 1,
                output: FAKE_AWS_KEY,
                status: "completed",
                task_id: "9",
            });
            expect(summary).toBe("The background command exited with code 1.");
            expect(summary).not.toContain(FAKE_AWS_KEY);
        });

        it("reports a still-running command", () => {
            expect(
                sharedResult(grokSendCommandInputTool, {
                    output: "",
                    status: "running",
                    task_id: "9",
                }),
            ).toBe("The background command is still running.");
        });

        it("is disclosable", () => {
            expect(grokSendCommandInputTool.sharedOutputDisclosable).toBe(true);
        });
    });
});

describe("every registered tool's disclosure setting", () => {
    it("is off unless the tool also wrote a sentence to go with it", () => {
        const registered = [
            ...assembleClaudeTools(),
            ...assembleCodexTools("gpt-5.6-sol", "codex"),
            ...assembleCodexTools("gpt-5.6-luna", "codex"),
        ];
        expect(registered.length).toBeGreaterThan(20);

        // Disclosure is a decision about a tool's payload, so a tool that never
        // decided what its payload looks like has not made it. This catches the
        // flag arriving by copy-paste on a tool nobody thought about.
        const undescribedButDisclosable = registered
            .filter(
                (tool) =>
                    tool.sharedOutputDisclosable &&
                    tool.toSharedCall === undefined &&
                    tool.toSharedResult === undefined,
            )
            .map((tool) => tool.name);
        expect(undescribedButDisclosable).toEqual([]);
    });
});
