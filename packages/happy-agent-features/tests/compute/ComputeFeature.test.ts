import { Agent } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { ComputeFeature } from "../../sources/index.js";
import { InMemoryPersistence } from "../support/InMemoryPersistence.js";
import { ScriptedProvider } from "../support/ScriptedProvider.js";
import { providersOf, sharedKV, textTurn, user } from "../support/fixtures.js";
import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-features-compute");

describe("ComputeFeature", () => {
    it("offers every model the same ten tools", async () => {
        const provider = new ScriptedProvider([textTurn("answered")]);
        const agent = await Agent.create(ctx, {
            id: "compute-agent",
            providers: providersOf(provider),
            provider: "scripted",
            persistence: new InMemoryPersistence(),
            sharedKV: sharedKV(),
            features: [new ComputeFeature({ compute: new FakeCompute() })],
        });

        await agent.send(ctx, user("have a look around"), { await: true });
        await agent.waitForIdle();
        await agent.close();

        expect(provider.sessions[0]?.options.tools?.map((tool) => tool.name)).toEqual([
            "read_file",
            "write_file",
            "edit_file",
            "list_directory",
            "find_files",
            "search_files",
            "run_command",
            "read_command_output",
            "send_command_input",
            "stop_command",
        ]);
    });

    it("tells the model where it is and what the file tools will refuse", () => {
        const feature = new ComputeFeature({ compute: new FakeCompute("/srv/app") });

        const instructions = feature.instructions();

        expect(instructions).toContain("/srv/app");
        expect(instructions).toContain("Read a file before changing it");
        expect(instructions).toContain("comes back with a command ID");
    });

    it("asks for a decision only when a path leaves the workspace", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/sources/main.ts", "export const main = 1;\n");
        compute.write("/etc/passwd", "root:x:0:0\n");
        const { tool } = computeToolset(ctx, compute);

        expect(
            await tool("read_file").shouldReviewInAutoMode({ path: "sources/main.ts" }, ctx),
        ).toBe(false);
        expect(await tool("read_file").shouldReviewInAutoMode({ path: "/etc/passwd" }, ctx)).toBe(
            true,
        );
        expect(tool("read_file").describeAutoPermissionAction?.({ path: "/etc/passwd" }, ctx)).toBe(
            'reading "/etc/passwd". Access: unrestricted filesystem access outside the workspace sandbox',
        );
    });

    it("asks for a decision before changing a path the machine guards", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/.git/config", "[core]\n");
        compute.protectedPaths = ["/workspace/.git"];
        const { tool } = computeToolset(ctx, compute);

        expect(await tool("write_file").shouldReviewInAutoMode({ path: ".git/config" }, ctx)).toBe(
            true,
        );
        expect(
            await tool("write_file").shouldRunInFullAccessInAutoMode?.(
                { path: ".git/config" },
                ctx,
            ),
        ).toBe(true);
        expect(
            tool("write_file").describeAutoPermissionAction?.({ path: ".git/config" }, ctx),
        ).toContain("protected workspace path requiring Full access");
    });

    it("sees a link out of the workspace for what it is", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/escape.txt", "");
        compute.links.set("/workspace/escape.txt", "/etc/shadow");
        const { tool } = computeToolset(ctx, compute);

        expect(await tool("read_file").shouldReviewInAutoMode({ path: "escape.txt" }, ctx)).toBe(
            true,
        );
    });

    it("leaves an ordinary command sandboxed and asks about one that wants out", async () => {
        const { tool } = computeToolset(ctx, new FakeCompute());
        const run = tool("run_command");

        expect(await run.shouldReviewInAutoMode({ command: "pnpm test" }, ctx)).toBe(false);
        expect(
            await run.shouldReviewInAutoMode(
                { command: "curl https://example.com", escalate_sandbox: true },
                ctx,
            ),
        ).toBe(true);
        expect(
            await run.shouldRunInFullAccessInAutoMode?.(
                { command: "curl https://example.com", escalate_sandbox: true },
                ctx,
            ),
        ).toBe(true);
        expect(
            run.describeAutoPermissionAction?.(
                {
                    command: "curl https://example.com",
                    escalate_sandbox: true,
                    justification: "the release notes are online",
                },
                ctx,
            ),
        ).toContain("outside the workspace sandbox");
    });

    it("asks about typing into a live command without letting it out of the sandbox", async () => {
        const { tool } = computeToolset(ctx, new FakeCompute());
        const send = tool("send_command_input");

        expect(await send.shouldReviewInAutoMode({ command_id: 1, input: "yes\n" }, ctx)).toBe(
            true,
        );
        expect(send.shouldRunInFullAccessInAutoMode).toBeUndefined();
        expect(
            send.describeAutoPermissionAction?.({ command_id: 1, input: "yes\n" }, ctx),
        ).toContain("inside the sandbox it was started in");
    });

    it("shows what is still running and stops one by hand, without ever disposing the machine", async () => {
        const compute = new FakeCompute();
        compute.script("pnpm dev", { chunks: ["listening\n"], keepRunning: true });
        const { feature, tool } = computeToolset(ctx, compute);
        await tool("run_command").execute(ctx, { command: "pnpm dev", background: true });

        expect(feature.runningCommands()).toEqual([
            { command: "pnpm dev", cwd: "/workspace", sessionId: 1, status: "running" },
        ]);
        // Looking does not take output the model has not been given yet.
        compute.script("noop", {});
        expect((await feature.readCommand(1))?.status).toBe("running");
        expect(await feature.stopCommand(1)).toBe(true);
        expect(feature.runningCommands()).toEqual([]);
    });
});
