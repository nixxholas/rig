import type { AgentContext } from "../context/AgentContext.js";
import type { Skill } from "./Skill.js";
import { loadSkills } from "./loadSkills.js";
import { errorToMessage } from "../../errorToMessage.js";

/**
 * Loads the one skill catalog used by prompts, slash commands, and future skill consumers.
 *
 * Plugin discovery is optional enrichment. If it fails, ordinary filesystem skills remain
 * available and the agent turn continues.
 */
export async function loadAgentSkillCatalog(
    context: Pick<AgentContext, "fs" | "plugins">,
): Promise<readonly Skill[]> {
    if (context.plugins === undefined) return loadSkills(context.fs);

    try {
        return await context.plugins.loadSkills(context.fs);
    } catch (error) {
        console.error(
            `Rig could not load plugin skills; continuing without them: ${errorToMessage(error)}`,
        );
        return loadSkills(context.fs);
    }
}
