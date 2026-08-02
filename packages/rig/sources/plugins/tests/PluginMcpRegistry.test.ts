import { describe, expect, it } from "vitest";

import type { HappyMcpEvent, HappyMcpServerRegistration } from "happy-plugins";

import type { AgentContext } from "../../agent/context/AgentContext.js";
import type { AnyDefinedTool } from "../../agent/types.js";
import {
    PluginMcpRegistry,
    type PluginMcpRegistrationRetirement,
} from "../PluginMcpRegistry.js";

describe("PluginMcpRegistry", () => {
    it("reports each live registration retirement to its owning generation", () => {
        const registry = new PluginMcpRegistry();
        const retired: PluginMcpRegistrationRetirement[] = [];
        const connection = registry.createConnection(
            { folder: "projects", name: "Projects" },
            { onActiveRegistrationRetired: (retirement) => retired.push(retirement) },
        );
        const disconnectedId = connection.register(server("Catalog", ["list_projects"]));
        const detach = connection.attach(disconnectedId, () => true);

        detach();

        const unregisteredId = connection.register(server("Catalog", ["list_projects"]));
        connection.attach(unregisteredId, () => true);
        connection.unregister(unregisteredId);
        expect(retired).toEqual([
            { reason: "The plugin MCP connection closed.", status: "failed" },
            { reason: "The plugin unregistered this MCP server.", status: "stopped" },
        ]);
    });

    it("forwards concurrent calls, accepts reverse completion, and preserves MCP permissions", async () => {
        const registry = new PluginMcpRegistry();
        const connection = registry.createConnection({ folder: "projects", name: "Projects" });
        const registrationId = connection.register(server("Catalog", ["list_projects"]));
        const events: HappyMcpEvent[] = [];
        connection.attach(registrationId, (event) => {
            events.push(event);
            return true;
        });

        const loaded = await registry.load("/workspace", "auto");
        expect(loaded.servers).toEqual([
            { name: "Projects · Catalog", status: "connected", toolCount: 1 },
        ]);
        const tool = loaded.tools[0]!;
        expect(tool.name).toBe("mcp__Projects___Catalog__list_projects");
        expect(tool.requiresAutoOrFullAccess).toBe(true);
        expect(await tool.shouldReviewInAutoMode({} as never, {} as AgentContext)).toBe(true);
        expect(tool.describeAutoPermissionAction?.({} as never, {} as AgentContext)).toContain(
            "outside Rig’s filesystem sandbox",
        );

        const first = invoke(tool, { request: "first" });
        const second = invoke(tool, { request: "second" });
        const calls = events.filter(
            (event): event is Extract<HappyMcpEvent, { type: "call" }> => event.type === "call",
        );
        expect(calls.map((call) => call.arguments)).toEqual([
            { request: "first" },
            { request: "second" },
        ]);

        connection.complete(registrationId, calls[1]!.callId, result("second result"));
        connection.complete(registrationId, calls[0]!.callId, result("first result"));
        await expect(first).resolves.toEqual(result("first result").result);
        await expect(second).resolves.toEqual(result("second result").result);

        const failed = invoke(tool, { request: "failure" });
        const failedCall = events.findLast(
            (event): event is Extract<HappyMcpEvent, { type: "call" }> => event.type === "call",
        )!;
        connection.complete(registrationId, failedCall.callId, {
            error: "Expected plugin failure.",
        });
        await expect(failed).resolves.toEqual({
            content: [{ text: "Expected plugin failure.", type: "text" }],
            isError: true,
        });
    });

    it("retires stale calls on disconnect, cancellation, replacement, and timeout", async () => {
        const registry = new PluginMcpRegistry({ callTimeoutMs: 10 });
        const firstOwner = registry.createConnection({ folder: "projects", name: "Projects" });
        const firstId = firstOwner.register(server("Catalog", ["list_projects"]));
        const events: HappyMcpEvent[] = [];
        firstOwner.attach(firstId, (event) => {
            events.push(event);
            return true;
        });
        const firstTool = (await registry.load("/workspace", "auto")).tools[0]!;

        const cancelled = new AbortController();
        const cancelledCall = invoke(firstTool, {}, cancelled.signal);
        cancelled.abort();
        await expect(cancelledCall).rejects.toThrow("cancelled");
        expect(events.at(-1)).toMatchObject({ type: "cancel" });

        const staleCall = invoke(firstTool, {});
        const staleId = events.findLast(
            (event): event is Extract<HappyMcpEvent, { type: "call" }> => event.type === "call",
        )!.callId;
        firstOwner.close();
        await expect(staleCall).rejects.toThrow("stopped");
        expect(() => firstOwner.complete(firstId, staleId, result("too late"))).toThrow(
            "does not belong",
        );
        expect((await registry.load("/workspace", "auto")).tools).toEqual([]);

        const replacement = registry.createConnection({ folder: "projects", name: "Projects" });
        const replacementId = replacement.register(server("Catalog", ["list_projects"]));
        const replacementEvents: HappyMcpEvent[] = [];
        replacement.attach(replacementId, (event) => {
            replacementEvents.push(event);
            return true;
        });
        const replacementTool = (await registry.load("/workspace", "auto")).tools[0]!;
        await expect(invoke(replacementTool, {})).rejects.toThrow("timed out after 10ms");
        expect(replacementEvents.at(-1)).toMatchObject({ type: "cancel" });

        const disconnected = registry.createConnection({ folder: "clock", name: "Clock" });
        const disconnectedId = disconnected.register(server("Time", ["now"]));
        disconnected.attach(disconnectedId, () => false);
        const disconnectedTool = (await registry.load("/workspace", "auto")).tools.find((tool) =>
            tool.name.includes("Clock"),
        )!;
        await expect(invoke(disconnectedTool, {})).rejects.toThrow("disconnected before receiving");
    });

    it("rejects ambiguous plugin, server, tool, schema, result, and ownership identities", async () => {
        const registry = new PluginMcpRegistry();
        const owner = registry.createConnection({ folder: "one", name: "Projects" });
        const registrationId = owner.register(server("Catalog", ["list projects"]));
        const events: HappyMcpEvent[] = [];
        owner.attach(registrationId, (event) => {
            events.push(event);
            return true;
        });

        expect(() => owner.register(server("Catalog", ["other"]))).toThrow("server name");
        expect(() => owner.register(server("Other", ["echo value", "echo_value"]))).toThrow(
            "collide after normalization",
        );
        const duplicatePlugin = registry.createConnection({
            folder: "two",
            name: "projects",
        });
        expect(() => duplicatePlugin.register(server("Other", ["echo"]))).toThrow(
            "identity is ambiguous",
        );
        expect(() =>
            owner.register({
                name: "Malformed",
                tools: [
                    {
                        description: "Malformed",
                        inputSchema: { type: "string" },
                        name: "broken",
                    },
                ],
            } as unknown as HappyMcpServerRegistration),
        ).toThrow();
        expect(() =>
            duplicatePlugin.complete(registrationId, "unknown", result("wrong owner")),
        ).toThrow("does not belong");

        const tool = (await registry.load("/workspace", "auto")).tools[0]!;
        const pending = invoke(tool, {});
        const call = events.find(
            (event): event is Extract<HappyMcpEvent, { type: "call" }> => event.type === "call",
        )!;
        expect(() =>
            owner.complete(registrationId, call.callId, {
                result: { content: [{ text: 42, type: "text" }] },
            } as never),
        ).toThrow();
        owner.close();
        await expect(pending).rejects.toThrow("stopped");
    });

    it("keeps plugin MCP unavailable in restricted modes", async () => {
        const registry = new PluginMcpRegistry();
        const connection = registry.createConnection({ folder: "projects", name: "Projects" });
        const registrationId = connection.register(server("Catalog", ["list_projects"]));
        connection.attach(registrationId, () => true);

        for (const mode of ["read_only", "workspace_write"] as const) {
            const loaded = await registry.load("/workspace", mode);
            expect(loaded.tools).toEqual([]);
            expect(loaded.servers).toMatchObject([
                {
                    errorMessage: expect.stringContaining("Auto or Full access"),
                    status: "blocked",
                },
            ]);
        }
    });

    it("never offers app-only tools to an ordinary model session", async () => {
        const registry = new PluginMcpRegistry();
        const connection = registry.createConnection({ folder: "usage", name: "Usage" });
        const registrationId = connection.register({
            name: "Backend",
            tools: [
                {
                    _meta: { ui: { visibility: ["app"] } },
                    description: "Only the mounted MCP App may call this.",
                    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
                    name: "private_refresh",
                },
                {
                    _meta: { ui: { visibility: ["model", "app"] } },
                    description: "Both audiences may call this.",
                    inputSchema: { additionalProperties: false, properties: {}, type: "object" },
                    name: "read_usage",
                },
            ],
        });
        connection.attach(registrationId, () => true);

        const loaded = await registry.load("/workspace", "auto");
        expect(loaded.tools.map((tool) => tool.name)).toEqual(["mcp__Usage___Backend__read_usage"]);
        expect(
            registry.listAppTools("usage", connection.generation).map((tool) => tool.name),
        ).toEqual(["private_refresh", "read_usage"]);
    });
});

function server(name: string, tools: readonly string[]): HappyMcpServerRegistration {
    return {
        name,
        tools: tools.map((tool) => ({
            description: `Use ${tool}.`,
            inputSchema: {
                additionalProperties: true,
                properties: {},
                type: "object",
            },
            name: tool,
        })),
    };
}

function result(text: string) {
    return { result: { content: [{ text, type: "text" as const }] } };
}

function invoke(tool: AnyDefinedTool, args: unknown, signal?: AbortSignal): Promise<unknown> {
    return Promise.resolve(
        tool.execute(args as never, {} as AgentContext, signal === undefined ? {} : { signal }),
    );
}
