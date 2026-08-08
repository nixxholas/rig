import { Type } from "@sinclair/typebox";
import type { SessionTool } from "@/core/SessionTool.js";
import type { CodexToolDefinitionVendor } from "@/vendors/codex/CodexToolVendor.js";
import { toJsonSchema } from "@/vendors/codex/impl/toJsonSchema.js";
import type { NamespaceTool, Tool } from "openai/resources/responses/responses.js";

const clientToolSearch = {
    name: "tool_search",
    vendor: {
        provider: "codex",
        type: "tool_search",
        execution: "client",
    },
    description:
        "# Tool discovery\n\nSearches deferred tools and returns matching definitions for the next model call.\n\nSome tools may not have been provided upfront. Use `tool_search` to discover a relevant deferred tool.",
    parameters: Type.Object(
        {
            limit: Type.Optional(
                Type.Number({ description: "Maximum number of tools to return. Defaults to 8." }),
            ),
            query: Type.String({ description: "Search query for deferred tools." }),
        },
        { additionalProperties: false },
    ),
} as const satisfies SessionTool & { readonly vendor: CodexToolDefinitionVendor };

export function toCodexToolDefinitions(
    tools: readonly SessionTool[],
    options: { includeDeferred?: boolean } = {},
): Tool[] {
    const nativeNamespaceDescriptions = new Map([
        ["image_gen", "Tools in the image_gen namespace."],
        ["collaboration", "Tools for spawning and managing sub-agents."],
    ]);
    const output: Tool[] = [];
    const namespaces = new Map<string, NamespaceTool>();

    for (const tool of tools) {
        if (tool.deferLoading === true && options.includeDeferred !== true) continue;
        const definition = toCodexTool(tool);
        if (tool.namespace === undefined) {
            output.push(definition);
            continue;
        }
        let namespace = namespaces.get(tool.namespace);
        if (namespace === undefined) {
            namespace = {
                type: "namespace",
                name: tool.namespace,
                description:
                    tool.namespaceDescription ??
                    nativeNamespaceDescriptions.get(tool.namespace) ??
                    `Tools in the ${humanizeNamespace(tool.namespace)} namespace.`,
                tools: [],
            };
            namespaces.set(tool.namespace, namespace);
            output.push(namespace);
        }
        if (definition.type !== "function" && definition.type !== "custom") {
            throw new Error(
                `Namespaced Codex tool '${tool.namespace}.${tool.name}' must be a function or custom tool.`,
            );
        }
        namespace.tools.push(definition);
    }
    if (
        options.includeDeferred !== true &&
        tools.some((tool) => tool.deferLoading === true) &&
        !tools.some(
            (tool) =>
                (tool.vendor as Partial<CodexToolDefinitionVendor> | undefined)?.type ===
                "tool_search",
        )
    ) {
        output.push(toCodexTool(clientToolSearch));
    }
    return output;
}

function humanizeNamespace(namespace: string): string {
    return namespace.replaceAll("_", " ");
}

function toCodexTool(tool: SessionTool): Tool {
    if (tool.server !== undefined) {
        return structuredClone(tool.server) as Tool;
    }
    const vendor = tool.vendor as Partial<CodexToolDefinitionVendor> | undefined;
    if (
        vendor?.provider === "codex" &&
        vendor.type === "tool_search" &&
        vendor.execution === "client"
    ) {
        return {
            type: "tool_search",
            execution: "client",
            ...(tool.description === undefined ? {} : { description: tool.description }),
            ...(tool.parameters === undefined ? {} : { parameters: toJsonSchema(tool.parameters) }),
        };
    }
    if (tool.grammar !== undefined) {
        return {
            type: "custom",
            name: tool.name,
            ...(tool.description === undefined ? {} : { description: tool.description }),
            format: { type: "grammar", syntax: "lark", definition: tool.grammar.grammar },
        };
    }
    return {
        type: "function",
        name: tool.name,
        ...(tool.description === undefined ? {} : { description: tool.description }),
        strict: false,
        ...(tool.deferLoading === true ||
        (vendor?.provider === "codex" && vendor.type === "function" && vendor.deferLoading === true)
            ? { defer_loading: true }
            : {}),
        parameters: tool.parameters === undefined ? null : toJsonSchema(tool.parameters),
    };
}
