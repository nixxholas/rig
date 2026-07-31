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
                type: "local",
            }));
            const goldenTools = resolveClaudeTools(model);
            const goldenNames = goldenTools.map((tool) => tool.name).sort();
            const productionGoldenTools = productionTools.filter((tool) =>
                goldenNames.includes(tool.name),
            );

            // Rig owns its runtime tool surface and may add tools such as TaskInput that are not
            // present in the native capture. Every captured tool must still exist and preserve
            // the provider's callable shape.
            expect(productionGoldenTools.map((tool) => tool.name).sort()).toEqual(goldenNames);
            // Agent keeps the captured callable shape, but its runtime descriptions document
            // Rig's provider/model inference extensions. The task-control tools remain exact.
            for (const name of ["TaskOutput", "TaskStop"]) {
                expect(productionTools.find((tool) => tool.name === name)).toEqual(
                    goldenTools.find((tool) => tool.name === name),
                );
            }
        },
    );
});
