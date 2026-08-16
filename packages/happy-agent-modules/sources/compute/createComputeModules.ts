import { SkillsModule } from "../skills/SkillsModule.js";
import { ComputeModule, type ComputeModuleOptions } from "./ComputeModule.js";

export interface CreatedComputeModules {
    readonly computeModule: ComputeModule;
    readonly skillsModule: SkillsModule;
    readonly modules: readonly [ComputeModule, SkillsModule];
}

/** Create one shared module set; each configured agent receives its own cached compute. */
export function createComputeModules(options: ComputeModuleOptions = {}): CreatedComputeModules {
    const computeModule = new ComputeModule(options);
    const skillsModule = new SkillsModule({ compute: computeModule });
    return {
        computeModule,
        skillsModule,
        modules: [computeModule, skillsModule],
    };
}
