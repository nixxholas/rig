import { describe, expect, it, vi } from "vitest";

import { connectRig } from "@/connectRig.js";

describe("secret registration", () => {
    it("lists secrets and submits masked create and update form values", async () => {
        const requests: { body?: unknown; method: string; pathname: string }[] = [];
        const fetch = vi.fn<typeof globalThis.fetch>(async (input, init) => {
            const pathname = new URL(String(input)).pathname;
            requests.push({
                ...(init?.body === undefined ? {} : { body: JSON.parse(String(init.body)) }),
                method: init?.method ?? "GET",
                pathname,
            });
            if (pathname === "/secrets" && init?.method === "GET") {
                return Response.json({
                    secrets: [
                        {
                            description: "Deployment credentials.",
                            environmentVariables: ["DEPLOY_TOKEN"],
                            id: "deployment",
                        },
                    ],
                });
            }
            if (pathname === "/secrets" && init?.method === "POST") {
                return Response.json({
                    secret: {
                        description: "Publishing credentials.",
                        environmentVariables: ["NPM_TOKEN"],
                        id: "npm-publishing",
                    },
                });
            }
            if (pathname === "/secrets/deployment" && init?.method === "PATCH") {
                return Response.json({
                    secret: {
                        description: "Deployment credentials.",
                        environmentVariables: ["DEPLOY_TOKEN"],
                        id: "deployment",
                    },
                });
            }
            return new Response("not found", { status: 404 });
        });
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });

        await expect(rig.listSecrets()).resolves.toEqual([
            {
                description: "Deployment credentials.",
                environmentVariables: ["DEPLOY_TOKEN"],
                id: "deployment",
            },
        ]);
        await expect(
            rig.registerSecret({
                description: "Publishing credentials.",
                environment: { NPM_TOKEN: "new-secret-value" },
                id: "npm-publishing",
            }),
        ).resolves.toMatchObject({ id: "npm-publishing" });
        await expect(
            rig.updateSecret("deployment", {
                environment: { DEPLOY_TOKEN: "replacement-secret-value" },
            }),
        ).resolves.toMatchObject({ id: "deployment" });

        expect(requests).toEqual([
            { method: "GET", pathname: "/secrets" },
            {
                body: {
                    description: "Publishing credentials.",
                    environment: { NPM_TOKEN: "new-secret-value" },
                    id: "npm-publishing",
                },
                method: "POST",
                pathname: "/secrets",
            },
            {
                body: { environment: { DEPLOY_TOKEN: "replacement-secret-value" } },
                method: "PATCH",
                pathname: "/secrets/deployment",
            },
        ]);
        rig.close();
    });

    it("rejects malformed secret input before sending it", async () => {
        const fetch = vi.fn<typeof globalThis.fetch>();
        const rig = connectRig({ endpoint: "http://rig.test", fetch, token: "secret" });

        await expect(
            rig.registerSecret({
                description: "Bad variable.",
                environment: { "NOT-AN-ENV-NAME": "value" },
                id: "invalid",
            }),
        ).rejects.toThrow("valid secret registration");
        await expect(
            rig.updateSecret("invalid id", { environment: { TOKEN: "value" } }),
        ).rejects.toThrow("valid secret ID");
        expect(fetch).not.toHaveBeenCalled();
        rig.close();
    });
});
