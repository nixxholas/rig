import { describe, expect, it } from "vitest";

import { AttachmentContext } from "../attachments/AttachmentContext.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { requestSecretTool } from "./requestSecret.js";

describe("request_secret", () => {
    it("prepares a safe final-message request for the client", async () => {
        const harness = createJustBashToolHarness();
        harness.context.attachments = new AttachmentContext({
            idFactory: () => "attachment-1",
        });
        const args = {
            description: "Credentials used to publish releases.",
            environment_variables: ["NPM_TOKEN", "NPM_CONFIG_REGISTRY"],
            instructions: "Create an npm access token with permission to publish this package.",
            operation: "create" as const,
            secret_id: "npm-publishing",
        };

        await expect(
            requestSecretTool.execute(args, harness.context, { ctx: harness.ctx }),
        ).resolves.toEqual({
            attachment: {
                description: "Credentials used to publish releases.",
                environmentVariables: ["NPM_TOKEN", "NPM_CONFIG_REGISTRY"],
                id: "attachment-1",
                instructions: "Create an npm access token with permission to publish this package.",
                kind: "secret_request",
                operation: "create",
                secretId: "npm-publishing",
            },
            id: "attachment-1",
        });
        expect(harness.context.attachments.pending()).toHaveLength(1);
        expect(await requestSecretTool.shouldReviewInAutoMode(args, harness.context)).toBe(false);
    });

    it("requires an attachment context", async () => {
        const harness = createJustBashToolHarness();

        await expect(
            requestSecretTool.execute(
                {
                    description: "Deployment credentials.",
                    environment_variables: ["DEPLOY_TOKEN"],
                    instructions: "Paste the replacement deployment token.",
                    operation: "update",
                    secret_id: "deployment",
                },
                harness.context,
                { ctx: harness.ctx },
            ),
        ).rejects.toThrow("Attachments are unavailable for this agent run.");
    });
});
