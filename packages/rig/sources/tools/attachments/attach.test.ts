import { describe, expect, it, vi } from "vitest";

import { Value } from "@sinclair/typebox/value";

import type { SlotContext } from "../../agent/context/SlotContext.js";
import { createJustBashToolHarness } from "../testing/createJustBashToolHarness.js";
import { AttachmentContext } from "./AttachmentContext.js";
import { createAttachTool } from "./attach.js";
import { attachArgumentsSchema } from "./attachmentSchemas.js";

describe("attach tool", () => {
    it("accepts only string values in webapp query parameters", () => {
        expect(
            Value.Check(attachArgumentsSchema, {
                operation: "add",
                query: { report: "daily" },
                webapp: "usage-dashboard",
            }),
        ).toBe(true);
        expect(
            Value.Check(attachArgumentsSchema, {
                operation: "add",
                query: { report: 1 },
                webapp: "usage-dashboard",
            }),
        ).toBe(false);
    });

    it("prepares a webapp attachment locally with its requested destination", async () => {
        const harness = createJustBashToolHarness();
        harness.context.attachments = new AttachmentContext({ idFactory: () => "attachment-1" });
        const listWebapps = vi.fn(() => [
            {
                description: "Shows current spend.",
                iconThumbhash: "AQID",
                iconUrl: "/webapps/usage-dashboard/favicon.png",
                name: "usage-dashboard",
            },
        ]);
        harness.context.slots = { listWebapps } as unknown as SlotContext;
        const tool = createAttachTool();

        const args = {
            operation: "add" as const,
            path: "/reports/today",
            query: { range: "24h", team: "platform" },
            webapp: "usage-dashboard",
        };
        const result = await tool.execute(args, harness.context, {});

        expect(result).toEqual({
            attachment: {
                description: "Shows current spend.",
                id: "attachment-1",
                image: "/webapps/usage-dashboard/favicon.png",
                kind: "webapp",
                name: "usage-dashboard",
                path: "/reports/today",
                query: { range: "24h", team: "platform" },
                thumbhash: "AQID",
                webapp: "usage-dashboard",
            },
            id: "attachment-1",
            operation: "add",
        });
        expect(listWebapps).toHaveBeenCalledOnce();
        await expect(tool.shouldReviewInAutoMode(args, harness.context)).resolves.toBe(false);
        await expect(tool.shouldRunInFullAccessInAutoMode(args, harness.context)).resolves.toBe(
            false,
        );
    });

    it("rejects a webapp name that is not registered", async () => {
        const harness = createJustBashToolHarness();
        harness.context.attachments = new AttachmentContext();
        harness.context.slots = { listWebapps: () => [] } as unknown as SlotContext;

        await expect(
            createAttachTool().execute(
                { operation: "add", webapp: "missing-dashboard" },
                harness.context,
                {},
            ),
        ).rejects.toThrow('No webapp named "missing-dashboard" exists.');
    });

    it("rejects local paths outside the workspace and generated-media directory", async () => {
        const harness = createJustBashToolHarness({
            files: { "/private/secret.txt": "private" },
        });
        harness.context.attachments = new AttachmentContext();

        await expect(
            createAttachTool().execute(
                { operation: "add", path: "/private/secret.txt" },
                harness.context,
                {},
            ),
        ).rejects.toThrow("must be inside the active workspace or Rig-generated media directory");
    });

    it("allows a local attachment from the Rig-generated media directory", async () => {
        const harness = createJustBashToolHarness({
            files: { "/generated/result.txt": "done" },
        });
        harness.context.attachments = new AttachmentContext({
            idFactory: () => "attachment-1",
            scope: { projectId: "project-1", sessionId: "session-1" },
        });
        harness.context.generatedMedia = {
            hostDirectory: "/generated",
            modelDirectory: "/generated",
            remove: async () => undefined,
            write: async () => ({
                hostPath: "/generated/result.txt",
                location: "generated/result.txt",
                path: "/generated/result.txt",
            }),
        };

        await expect(
            createAttachTool().execute(
                { operation: "add", path: "/generated/result.txt" },
                harness.context,
                {},
            ),
        ).resolves.toMatchObject({
            attachment: {
                downloadUrl: "/sessions/session-1/attachments/attachment-1/download",
                kind: "file",
                name: "result.txt",
            },
            operation: "add",
        });
    });

    it("persists a Docker attachment into host-visible generated media", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/result.txt": "done" },
        });
        harness.context.attachments = new AttachmentContext({
            idFactory: () => "attachment-1",
            scope: { projectId: "project-1", sessionId: "session-1" },
        });
        const remove = vi.fn(async () => undefined);
        const write = vi.fn(async () => ({
            hostPath: "/host/generated/result-copy.txt",
            location: "generated/result-copy.txt" as const,
            path: "/happy/generated/result-copy.txt",
        }));
        harness.context.generatedMedia = {
            hostDirectory: "/host/generated",
            modelDirectory: "/happy/generated",
            remove,
            write,
        };

        const result = await createAttachTool().execute(
            { operation: "add", path: "/workspace/result.txt" },
            harness.context,
            {},
        );

        expect(result).toMatchObject({
            attachment: {
                downloadUrl: "/sessions/session-1/attachments/attachment-1/download",
                source: "generated/result-copy.txt",
            },
        });
        expect(write).toHaveBeenCalledWith(new TextEncoder().encode("done"), {
            extension: ".txt",
            preferredName: "result.txt",
        });
        expect(harness.context.attachments.remove("attachment-1")).toBe(true);
        await vi.waitFor(() =>
            expect(remove).toHaveBeenCalledWith("/host/generated/result-copy.txt"),
        );
    });

    it("gives video previews their own session-scoped URL", async () => {
        const harness = createJustBashToolHarness({
            files: { "/workspace/result.mp4": "video" },
        });
        harness.context.attachments = new AttachmentContext({
            idFactory: () => "attachment-1",
            scope: { projectId: "project-1", sessionId: "session-1" },
        });
        harness.context.generatedMedia = {
            hostDirectory: "/host/generated",
            modelDirectory: "/happy/generated",
            remove: async () => undefined,
            write: async () => ({
                hostPath: "/host/generated/result.mp4",
                location: "generated/result.mp4",
                path: "/happy/generated/result.mp4",
            }),
        };

        const result = await createAttachTool({
            prepare: async (source, id) => ({
                bytes: source.kind === "file" ? source.size : 0,
                duration: 1,
                height: 720,
                id,
                kind: "video" as const,
                mediaType: "video/mp4",
                name: "result.mp4",
                preview: {
                    height: 360,
                    mediaType: "image/png" as const,
                    path: "generated/preview.png",
                    thumbhash: "AQID",
                    width: 640,
                },
                source: source.source,
                width: 1280,
            }),
        }).execute({ operation: "add", path: "/workspace/result.mp4" }, harness.context, {});

        expect(result).toMatchObject({
            attachment: {
                downloadUrl: "/sessions/session-1/attachments/attachment-1/download",
                preview: {
                    downloadUrl: "/sessions/session-1/attachments/attachment-1/preview",
                    path: "generated/preview.png",
                },
                source: "generated/result.mp4",
            },
        });
    });
});
