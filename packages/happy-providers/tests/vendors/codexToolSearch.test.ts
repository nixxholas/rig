import { Type } from "@sinclair/typebox";
import { describe, expect, it } from "vitest";

import type { SessionTool } from "@/core/SessionTool.js";
import { searchCodexTools } from "@/vendors/codex/impl/searchCodexTools.js";
import { settleCodexToolSearch } from "@/vendors/codex/impl/settleCodexToolSearch.js";

const tools = [
    {
        name: "calendar_create_event",
        description: "Create a meeting on a calendar.",
        parameters: Type.Object({
            timezone: Type.String({ description: "IANA timezone for the event." }),
        }),
        deferLoading: true,
    },
    {
        name: "repository_search",
        description: "Find source code in a repository.",
        parameters: Type.Object({ query: Type.String() }),
        deferLoading: true,
    },
    {
        name: "music_lookup",
        description: "Find songs and albums.",
        parameters: Type.Object({}),
        deferLoading: true,
    },
] as const satisfies readonly SessionTool[];

describe("Codex tool search", () => {
    it("ranks tool names, descriptions, and parameter metadata", () => {
        expect(searchCodexTools(tools, "create calendar meeting")).toEqual([tools[0]]);
        expect(searchCodexTools(tools, "IANA timezones")).toEqual([tools[0]]);
        expect(searchCodexTools(tools, "finding", 1)).toEqual([tools[2]]);
        expect(searchCodexTools(tools, "weather forecast")).toEqual([]);
    });

    it("settles client discovery with native output and removes it from executor work", () => {
        const settled = settleCodexToolSearch(
            {
                assistantText: "",
                responseItems: [
                    JSON.stringify({
                        type: "tool_search_call",
                        call_id: "search-1",
                        execution: "client",
                        arguments: { query: "calendar meeting" },
                    }),
                ],
                toolCalls: [
                    {
                        callId: "search-1",
                        name: "tool_search",
                        arguments: '{"query":"calendar meeting"}',
                        vendor: { provider: "codex", type: "tool_search_call" },
                    },
                ],
            },
            tools,
        );

        expect(settled.settled).toBe(true);
        expect(settled.result.toolCalls).toEqual([]);
        expect(JSON.parse(settled.result.responseItems.at(-1)!)).toMatchObject({
            type: "tool_search_output",
            call_id: "search-1",
            execution: "client",
            status: "completed",
            tools: [
                {
                    type: "function",
                    name: "calendar_create_event",
                    defer_loading: true,
                },
            ],
        });
    });

    it("keeps an ordinary call while settling a parallel discovery call", () => {
        const settled = settleCodexToolSearch(
            {
                assistantText: "",
                responseItems: [],
                toolCalls: [
                    {
                        callId: "search-1",
                        name: "tool_search",
                        arguments: '{"query":"repository source"}',
                        vendor: { provider: "codex", type: "tool_search_call" },
                    },
                    {
                        callId: "shell-1",
                        name: "exec_command",
                        arguments: '{"cmd":"pwd"}',
                        vendor: { provider: "codex", type: "function_call" },
                    },
                ],
            },
            tools,
        );

        expect(settled.result.toolCalls).toEqual([
            expect.objectContaining({ callId: "shell-1", name: "exec_command" }),
        ]);
        expect(
            settled.result.responseItems.filter(
                (item) => JSON.parse(item).type === "tool_search_output",
            ),
        ).toHaveLength(1);
    });
});
