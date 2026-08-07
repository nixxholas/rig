import { describe, expect, it } from "vitest";

import { resolveClaudeTools } from "@/vendors/claude/impl/resolveClaudeTools.js";
import { assembleClaudeTools } from "../../../rig/sources/agent/tools/claude/assembleClaudeTools.js";

describe("Claude provider tool goldens", () => {
    it.each(["opus[1m]", "sonnet[1m]"])(
        "matches the production Claude tool contract for %s",
        (model) => {
            const productionTools = assembleClaudeTools().map((tool) => ({
                description: tool.description,
                name: tool.name,
                parameters: tool.arguments,
            }));
            const goldenTools = resolveClaudeTools(model);
            const directGoldenTools = goldenTools.filter(
                (tool) => tool.name !== "WebFetch" && tool.name !== "WebSearch",
            );
            const directGoldenNames = directGoldenTools.map((tool) => tool.name).sort();
            const productionGoldenTools = productionTools.filter((tool) =>
                directGoldenNames.includes(tool.name),
            );

            // Rig owns its runtime tool surface and may add tools such as TaskInput that are not
            // present in the native capture. Every directly executed captured tool still preserves
            // the provider's callable shape.
            expect(productionGoldenTools.map((tool) => tool.name).sort()).toEqual(
                directGoldenNames,
            );

            // Agent and TaskStop keep their captured callable shapes, but their runtime
            // descriptions document Rig's provider/model and stable-agent-identity extensions.
            const taskStop = productionTools.find((tool) => tool.name === "TaskStop");
            const goldenTaskStop = goldenTools.find((tool) => tool.name === "TaskStop");
            expect(withoutDescriptions(taskStop)).toEqual(withoutDescriptions(goldenTaskStop));
            expect(taskStop?.description).toContain("Agent ID");
            expect(taskStop?.description).toContain("canonical path");
            expect(taskStop?.parameters.properties.task_id.description).toContain("Agent ID");

            // TaskOutput keeps the captured arguments, but a Rig agent notifies its parent when it
            // finishes, so waiting on one is deliberately allowed to last an hour instead of
            // Claude's ten-minute ceiling, and its description explains that.
            const taskOutput = productionTools.find((tool) => tool.name === "TaskOutput");
            const goldenTaskOutput = goldenTools.find((tool) => tool.name === "TaskOutput");
            expect(Object.keys(taskOutput?.parameters.properties ?? {})).toEqual(
                Object.keys(goldenTaskOutput?.parameters?.properties ?? {}),
            );
            expect(taskOutput?.parameters.required).toEqual(goldenTaskOutput?.parameters?.required);
            expect(taskOutput?.parameters.properties.timeout.maximum).toBe(3_600_000);
        },
    );
});

function withoutDescriptions(value: unknown): unknown {
    return JSON.parse(
        JSON.stringify(value, (key, nested) => (key === "description" ? undefined : nested)),
    ) as unknown;
}
