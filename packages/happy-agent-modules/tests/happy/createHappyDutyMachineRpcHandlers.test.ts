import type { AgentMessageMetadata, AgentSystemRef } from "@slopus/happy-agent-base";
import type { Context } from "@steve.kite/stdlib";
import { describe, expect, it } from "vitest";

import { DutyModule } from "../../sources/duty/DutyModule.js";
import { createHappyDutyMachineRpcHandlers } from "../../sources/happy/createHappyDutyMachineRpcHandlers.js";
import { moduleDatabase } from "../support/moduleDatabase.js";

function recordingAgents(): { readonly ref: AgentSystemRef; readonly wakes: string[] } {
    const wakes: string[] = [];
    return {
        ref: {
            abort: async () => undefined,
            send: async (
                _ctx: Context,
                agentId: string,
                _message: unknown,
                _options?: { readonly metadata?: AgentMessageMetadata },
            ) => {
                wakes.push(agentId);
            },
        } as unknown as AgentSystemRef,
        wakes,
    };
}

describe("createHappyDutyMachineRpcHandlers", () => {
    it("issues and reports a Duty for an existing Happy session identity", async () => {
        const duties = new DutyModule();
        const database = moduleDatabase(duties.migrations, "happy-duty-machine-rpc");
        const agents = recordingAgents();
        await database.ready;
        duties.beforeStart(database.context, agents.ref);
        try {
            const handlers = createHappyDutyMachineRpcHandlers(duties);
            const issue = handlers.find((handler) => handler.method === "duty-issue");
            const status = handlers.find((handler) => handler.method === "duty-status");
            if (issue === undefined || status === undefined)
                throw new Error("Duty RPC handlers are missing.");

            await expect(
                issue.handle(database.context, {
                    agentId: "happy-session-legacy",
                    allowedTools: ["read_file"],
                    charter: "Inspect the deployed service.",
                    confirmation: "issue-duty",
                    dutyId: "duty-production-check",
                    every: 60_000,
                    permissionCeiling: "workspace_write",
                    tenureId: "tenure-production-check",
                    trigger: "Run the compatibility check.",
                }),
            ).resolves.toMatchObject({
                duty: {
                    agentId: "happy-session-legacy",
                    every: 60_000,
                    status: "active",
                },
                run: { status: "queued" },
            });
            expect(agents.wakes).toEqual(["happy-session-legacy"]);
            expect(
                (await duties.duty(database.context, "happy-session-legacy"))?.roster,
            ).toBeUndefined();
            await expect(
                status.handle(database.context, { agentId: "happy-session-legacy" }),
            ).resolves.toMatchObject({
                duty: { dutyId: "duty-production-check" },
                run: { status: "queued" },
            });
            await expect(
                issue.handle(database.context, { agentId: "happy-session-legacy" }),
            ).rejects.toThrow("confirmation");
        } finally {
            database.close();
        }
    });
});
