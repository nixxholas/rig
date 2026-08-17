import type { AgentModuleScope, AnyAgentTool } from "@slopus/happy-agent-base";
import { describe, expect, it, vi } from "vitest";

import { SecretsModule } from "../../sources/secrets/SecretsModule.js";
import { secretsMigrations } from "../../sources/secrets/SecretDatabase.js";
import type { SecretEvent } from "../../sources/secrets/SecretEvent.js";
import { moduleDatabase, type ModuleDatabase } from "../support/moduleDatabase.js";

const AGENT = "agent-tools";

async function withDatabase<T>(
    name: string,
    callback: (
        database: ModuleDatabase & {
            readonly database: import("@slopus/happy-agent-base").AgentDatabase;
        },
    ) => Promise<T>,
): Promise<T> {
    const database = moduleDatabase(secretsMigrations, name);
    await database.ready;
    try {
        return await callback(database);
    } finally {
        database.close();
    }
}

function scope(agentId = AGENT): AgentModuleScope {
    return { agent: { id: agentId } } as AgentModuleScope;
}

function toolByName(tools: readonly AnyAgentTool[], name: string): AnyAgentTool {
    const tool = tools.find((candidate) => candidate.name === name);
    if (tool === undefined) throw new Error(`Missing tool ${name}`);
    return tool;
}

describe("SecretsModule event and tool contracts", () => {
    it("publishes one stable deeply frozen event to transactional and post-commit listeners", async () => {
        await withDatabase("secrets-events-freeze", async (database) => {
            let transactionalEvent: SecretEvent | undefined;
            let postCommitEvent: SecretEvent | undefined;
            const module = new SecretsModule({
                eventIdFactory: () => "event-stable",
                clock: () => 123,
                listener: {
                    onEventTransactional: (_ctx, event) => {
                        transactionalEvent = event;
                        expect(Object.isFrozen(event)).toBe(true);
                        if (event.type === "secret_registered") {
                            expect(Object.isFrozen(event.secret)).toBe(true);
                            expect(() => {
                                event.secret.description = "changed";
                            }).toThrow();
                        }
                    },
                    onEvent: (_ctx, event) => {
                        postCommitEvent = event;
                    },
                },
            });

            await module.register(database.context, AGENT, {
                id: "frozen",
                description: "Original",
                environment: { TOKEN: "never in event" },
            });

            expect(transactionalEvent).toBeDefined();
            expect(postCommitEvent).toBeDefined();
            expect(postCommitEvent).toBe(transactionalEvent);
            expect(postCommitEvent).toEqual({
                type: "secret_registered",
                eventId: "event-stable",
                at: 123,
                agentId: AGENT,
                secret: {
                    id: "frozen",
                    description: "Original",
                    environmentVariables: ["TOKEN"],
                    revision: "1",
                },
            });
            expect(JSON.stringify(postCommitEvent)).not.toContain("never in event");
        });
    });

    it("defers post-commit events to the outer transaction and discards them on rollback", async () => {
        await withDatabase("secrets-events-outer-commit", async (database) => {
            const postCommit: SecretEvent[] = [];
            const module = new SecretsModule({
                listener: {
                    onEvent: async (_ctx, event) => {
                        postCommit.push(event);
                    },
                },
            });
            await database.context.inTx(async (outer) => {
                await module.register(outer, AGENT, {
                    id: "outer",
                    description: "Outer",
                    environment: { TOKEN: "value" },
                });
                expect(postCommit).toEqual([]);
            });
            expect(postCommit).toHaveLength(1);

            const failing = new SecretsModule({
                listener: {
                    onEventTransactional: async () => {
                        throw new Error("transactional listener failed");
                    },
                    onEvent: async (_ctx, event) => {
                        postCommit.push(event);
                    },
                },
            });
            await expect(
                database.context.inTx(async (rollbackContext) => {
                    await failing.register(rollbackContext, AGENT, {
                        id: "rolled-back",
                        description: "Should not persist",
                        environment: { TOKEN: "value" },
                    });
                }),
            ).rejects.toThrow("transactional listener failed");
            expect(await module.reference(database.context, AGENT, "rolled-back")).toBeUndefined();
            expect(postCommit).toHaveLength(1);
        });
    });

    it("contains post-commit listener errors and invokes the advisory reporter", async () => {
        await withDatabase("secrets-events-post-commit-error", async (database) => {
            const report = vi.fn(async () => undefined);
            const hostile = {
                get message(): never {
                    throw new Error("message trap");
                },
                [Symbol.toPrimitive](): never {
                    throw new Error("primitive trap");
                },
            };
            const module = new SecretsModule({
                listener: {
                    onEvent: async () => {
                        throw hostile;
                    },
                },
                onPostCommitError: report,
            });

            await expect(
                module.register(database.context, AGENT, {
                    id: "post-commit",
                    description: "Committed",
                    environment: { TOKEN: "value" },
                }),
            ).resolves.toMatchObject({ id: "post-commit" });
            expect(report).toHaveBeenCalledOnce();
            expect((report.mock.calls as unknown[][])[0]?.[2]).toBe(hostile);
        });
    });

    it("calls listener methods with their owning receiver", async () => {
        await withDatabase("secrets-events-receiver", async (database) => {
            let transactionalReceiver: unknown;
            let postCommitReceiver: unknown;
            const listener = {
                onEventTransactional(this: unknown) {
                    transactionalReceiver = this;
                },
                onEvent(this: unknown) {
                    postCommitReceiver = this;
                },
            };
            const module = new SecretsModule({ listener });
            await module.register(database.context, AGENT, {
                id: "receiver",
                description: "Receiver",
                environment: { TOKEN: "value" },
            });
            expect(transactionalReceiver).toBe(listener);
            expect(postCommitReceiver).toBe(listener);
        });
    });

    it("exposes exactly four common safe tools with durable mutation semantics", async () => {
        await withDatabase("secrets-tools-surface", async (database) => {
            const module = new SecretsModule();
            const hooks = module.beforeStart();
            const tools = await hooks.tools?.(database.context, scope());
            if (tools === undefined) throw new Error("Expected secret tools");
            expect(tools.map((tool) => tool.name)).toEqual([
                "list_secrets",
                "reference_secret",
                "attach_secret",
                "detach_secret",
            ]);
            expect(
                tools.every(
                    (tool) => tool.shouldReviewInAutoMode?.({} as never, {} as never) === false,
                ),
            ).toBe(true);
            expect(tools.every((tool) => tool.durable === true)).toBe(true);
            expect(toolByName(tools, "list_secrets").transactional).not.toBe(true);
            expect(toolByName(tools, "reference_secret").transactional).not.toBe(true);
            expect(toolByName(tools, "attach_secret").transactional).toBe(true);
            expect(toolByName(tools, "detach_secret").transactional).toBe(true);
            expect(JSON.stringify(tools)).not.toContain("resolveForHost");
            expect(JSON.stringify(tools)).not.toContain("resolveForCommand");
        });
    });

    it("executes each tool through the same public operation and keeps all model output metadata-only", async () => {
        await withDatabase("secrets-tools-execution", async (database) => {
            const module = new SecretsModule();
            await module.register(database.context, AGENT, {
                id: "tool-secret",
                description: "Tool secret",
                environment: { TOKEN: "tool-only-value" },
            });
            const hooks = module.beforeStart();
            const tools = await hooks.tools?.(database.context, scope());
            if (tools === undefined) throw new Error("Expected secret tools");
            const list = toolByName(tools, "list_secrets");
            const reference = toolByName(tools, "reference_secret");
            const attach = toolByName(tools, "attach_secret");
            const detach = toolByName(tools, "detach_secret");

            const listed = (await list.execute(database.context, {}, undefined as never)) as {
                secrets: readonly Record<string, unknown>[];
            };
            const referenced = (await reference.execute(
                database.context,
                { id: "tool-secret" },
                undefined as never,
            )) as { secret: Record<string, unknown> };
            const attached = (await attach.execute(
                database.context,
                { scopeRef: "tool-scope", secretId: "tool-secret" },
                undefined as never,
            )) as {
                attachment: Record<string, unknown>;
                secret: Record<string, unknown>;
            };
            const detached = (await detach.execute(
                database.context,
                { scopeRef: "tool-scope", secretId: "tool-secret" },
                undefined as never,
            )) as { detached: boolean; scopeRef: string; secretId: string };
            expect(listed).toMatchObject({ secrets: [{ id: "tool-secret" }] });
            expect(referenced).toEqual({ secret: listed.secrets[0] });
            expect(attached).toMatchObject({
                attachment: { scopeRef: "tool-scope", secretId: "tool-secret" },
                secret: { id: "tool-secret" },
            });
            expect(detached).toEqual({
                detached: true,
                scopeRef: "tool-scope",
                secretId: "tool-secret",
            });

            const rendered = [
                ...list.toLLM(listed),
                ...reference.toLLM(referenced),
                ...attach.toLLM(attached),
                ...detach.toLLM(detached),
            ]
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("\n");
            expect(rendered).toContain("tool-secret");
            expect(rendered).not.toContain("tool-only-value");
        });
    });

    it("formats bounded pages and preserves actionable identity at the minimum output budget", async () => {
        await withDatabase("secrets-tools-formatting", async (database) => {
            const module = new SecretsModule({
                maxPageSize: 2,
                maxOutputCharacters: 256,
            });
            await module.register(database.context, AGENT, {
                id: "first",
                description: "A".repeat(2_000),
                environment: { TOKEN: "value" },
            });
            await module.register(database.context, AGENT, {
                id: "second",
                description: "Second",
                environment: { OTHER: "value" },
            });
            const page = await module.list(database.context, AGENT, { limit: 2 });
            const formatted = module.formatPageForModel(page);
            expect(formatted.length).toBeLessThanOrEqual(256);
            expect(formatted).toContain("first");
            expect(formatted).toContain("next=2");
            expect(module.formatDetachForModel(false, "scope", "first")).toContain("first");
            expect(module.formatAttachmentForModel("scope", page.secrets[0]!)).toContain("first");
        });
    });
});
