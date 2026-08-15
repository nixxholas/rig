import { AgentsMdModule } from "../agentsMd/AgentsMdModule.js";
import { SkillsModule } from "../skills/SkillsModule.js";
import {
    ComputeModule,
    type ComputeModuleOptions,
} from "./ComputeModule.js";

export interface CreatedComputeModules {
    readonly computeModule: ComputeModule;
    readonly agentsMdModule: AgentsMdModule;
    readonly skillsModule: SkillsModule;
    readonly modules: readonly [ComputeModule, AgentsMdModule, SkillsModule];
}

/** Create one shared module set; each configured agent receives its own cached compute. */
export function createComputeModules(
    options: ComputeModuleOptions = {},
): CreatedComputeModules {
    const computeModule = new ComputeModule(options);
    const agentsMdModule = new AgentsMdModule({ compute: computeModule });
    const skillsModule = new SkillsModule({ compute: computeModule });
    return {
        computeModule,
        agentsMdModule,
        skillsModule,
        modules: [computeModule, agentsMdModule, skillsModule],
    };
}