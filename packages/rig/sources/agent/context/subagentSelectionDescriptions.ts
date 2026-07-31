import { builtinModelProfiles } from "@slopus/rig-execution";

// Every spawn tool asks for the child's model and effort in the same words, because an inherited
// choice is how a whole tree of agents silently ends up running at the parent's effort. The effort
// levels come from Rig's curated catalog, so a model reading the tool schema alone can still pick a
// level that exists for the model it chose.
const CATALOG_PROVIDER_TYPES = ["claude", "codex", "grok"] as const;

function describeEffortLevelsByModel(): string {
    const lines = new Map<string, string>();
    for (const providerType of CATALOG_PROVIDER_TYPES) {
        for (const profile of builtinModelProfiles(providerType, providerType)) {
            if (profile.hidden === true || lines.has(profile.id)) continue;
            const levels = profile.model.thinkingLevels
                .map((level) =>
                    level === profile.model.defaultThinkingLevel ? `${level} (default)` : level,
                )
                .join(", ");
            lines.set(profile.id, `- ${profile.id} (${profile.name}): ${levels}`);
        }
    }
    return [...lines.values()].join("\n");
}

export const SUBAGENT_MODEL_ARGUMENT_DESCRIPTION =
    "Model ID for the new agent, written exactly as it appears in the Available models section of the system prompt. Required: pick a model for this task instead of inheriting one.";

export const SUBAGENT_EFFORT_ARGUMENT_DESCRIPTION = [
    "Reasoning effort for the new agent. Required: pick it for this task. Use the model's default, or a lower level, for research, review, and other bounded work; only use xhigh, max, or ultra when the user asked for that effort.",
    "",
    "Allowed effort for each model:",
    describeEffortLevelsByModel(),
    "",
    "A model this session cannot use is absent from the Available models section of the system prompt; the levels above are the only ones the chosen model accepts.",
].join("\n");
