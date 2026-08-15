import { withAgentConfig } from "@slopus/happy-agent-base";
import { createRootContext } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import {
    ComputeModule,
    createComputeModules,
    type HostComputeProvider,
} from "../../sources/index.js";
import { FakeCompute } from "./support/FakeCompute.js";
import { computeToolset } from "./support/computeTools.js";

const ctx = createRootContext().named("happy-agent-modules-compute");

describe("ComputeModule", () => {
    it("creates and caches one distinct compute per agent for every module", async () => {
        const computes: FakeCompute[] = [];
        const provider: HostComputeProvider = {
            id: "host",
            create: async (_ctx, config) => {
                const compute = new FakeCompute(config.cwd);
                computes.push(compute);
                return compute;
            },
        };
        const created = createComputeModules({ provider });
        const agentACtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/workspace/a" } },
        });
        const agentBCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/workspace/b", providerId: "host" } },
        });

        const [agentA, agentAAgain] = await Promise.all([
            created.computeModule.resolve(agentACtx, "agent-a"),
            created.computeModule.resolve(agentACtx, "agent-a"),
        ]);
        const agentB = await created.computeModule.resolve(agentBCtx, "agent-b");

        expect(agentAAgain).toBe(agentA);
        expect(agentB).not.toBe(agentA);
        expect(computes).toHaveLength(2);
        expect(created.modules.map((module) => module.name)).toEqual([
            "compute",
            "agents-md",
            "skills",
        ]);

        const fakeA = agentA as FakeCompute;
        fakeA.directories.add("/workspace/a/.git");
        fakeA.write("/workspace/a/AGENTS.md", "Agent A instructions.");
        await expect(
            created.agentsMdModule.read(agentACtx, "agent-a"),
        ).resolves.toMatchObject({
            cwd: "/workspace/a",
            documents: [{ text: "Agent A instructions." }],
        });
        expect(computes).toHaveLength(2);

        let finishDisposal: (() => void) | undefined;
        fakeA.disposeWait = new Promise<void>((resolve) => {
            finishDisposal = resolve;
        });
        const archiving = created.computeModule.agentArchived?.(
            ctx,
            {} as never,
            { id: "agent-a" },
        );
        const replacementPending = created.computeModule.resolve(
            agentACtx,
            "agent-a",
        );
        await expect(
            Promise.race([
                archiving?.then(() => "archived"),
                Promise.resolve("disposing"),
            ]),
        ).resolves.toBe("disposing");
        await expect(
            Promise.race([
                replacementPending.then(() => "replaced"),
                Promise.resolve("disposing"),
            ]),
        ).resolves.toBe("disposing");
        finishDisposal?.();
        await archiving;
        expect(fakeA.disposeCount).toBe(1);
        const replacementA = await replacementPending;
        expect(replacementA).not.toBe(agentA);
        expect(computes).toHaveLength(3);
    });

    it("does nothing for an agent without compute configuration", async () => {
        const module = new ComputeModule();
        await expect(module.resolve(ctx, "agent-a")).resolves.toBeUndefined();
        await expect(
            module.tools(ctx, { agent: { id: "agent-a" } } as never),
        ).resolves.toEqual([]);
    });

    it("offers every model the same ten tools", async () => {
        const { tools } = await computeToolset(ctx, new FakeCompute());
        expect(tools.map((tool) => tool.name)).toEqual([
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

    it("tells each model where its own compute is", async () => {
        const compute = new FakeCompute("/srv/app");
        const provider: HostComputeProvider = {
            id: "host",
            create: async () => compute,
        };
        const module = new ComputeModule({ provider });
        const agentCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/srv/app" } },
        });
        const instructions = await module.instructions(
            agentCtx,
            { agent: { id: "agent-a" } } as never,
        );

        expect(instructions).toContain("/srv/app");
        expect(instructions).toContain("Read a file before changing it");
        expect(instructions).toContain("comes back with a command ID");
    });

    it("rejects invalid computes returned by the global provider", async () => {
        const dockerLike = { ...new FakeCompute(), kind: "docker" };
        const dockerModule = new ComputeModule({
            provider: { id: "host", create: async () => dockerLike as never },
        });
        const agentCtx = withAgentConfig(ctx, {
            modules: { compute: { cwd: "/workspace" } },
        });
        await expect(dockerModule.resolve(agentCtx, "agent-a")).rejects.toThrow(
            "returned an invalid compute",
        );
        const mismatched = new FakeCompute();
        (mismatched.fs as { cwd: string }).cwd = "/another-workspace";
        const mismatchedModule = new ComputeModule({
            provider: { id: "host", create: async () => mismatched },
        });
        await expect(mismatchedModule.resolve(agentCtx, "agent-a")).rejects.toThrow(
            "mismatched working directories",
        );
    });

    it("asks for a decision only when a path leaves the workspace", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/sources/main.ts", "export const main = 1;\n");
        compute.write("/etc/passwd", "root:x:0:0\n");
        const { tool } = await computeToolset(ctx, compute);

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

    it("reviews Git control writes so Auto can grant the Full access they require", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/.git/config", "[core]\n");
        const { tool } = await computeToolset(ctx, compute);

        expect(await tool("write_file").shouldReviewInAutoMode({ path: ".git/config" }, ctx)).toBe(
            true,
        );
        expect(
            tool("write_file").describeAutoPermissionAction?.({ path: ".git/config" }, ctx),
        ).toBe(
            'writing "/workspace/.git/config". Access: protected Git control path requiring Full access',
        );
    });

    it("sees a link out of the workspace for what it is", async () => {
        const compute = new FakeCompute();
        compute.write("/workspace/escape.txt", "");
        compute.links.set("/workspace/escape.txt", "/etc/shadow");
        const { tool } = await computeToolset(ctx, compute);

        expect(await tool("read_file").shouldReviewInAutoMode({ path: "escape.txt" }, ctx)).toBe(
            true,
        );
        expect(
            tool("read_file").describeAutoPermissionAction?.(
                { path: "escape.txt" },
                ctx,
            ),
        ).toBe(
            'reading "/workspace/escape.txt". Access: reviewed filesystem path requiring Full access after canonical path checks',
        );
    });

    it("leaves an ordinary command sandboxed and asks about one that wants out", async () => {
        const { tool } = await computeToolset(ctx, new FakeCompute());
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
        const { tool } = await computeToolset(ctx, new FakeCompute());
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
        const { module, tool, call } = await computeToolset(ctx, compute);
        await tool("run_command").execute(ctx, { command: "pnpm dev", background: true }, call);

        expect(await module.runningCommands("compute-agent")).toEqual([
            { command: "pnpm dev", cwd: "/workspace", sessionId: 1, status: "running" },
        ]);
        // Looking does not take output the model has not been given yet.
        compute.script("noop", {});
        expect((await module.readCommand("compute-agent", 1))?.status).toBe("running");
        expect(await module.stopCommand("compute-agent", 1)).toBe(true);
        expect(await module.runningCommands("compute-agent")).toEqual([]);
    });
});
