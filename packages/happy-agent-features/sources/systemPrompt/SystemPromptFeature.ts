import type { AgentFeature, AgentFeatureScope } from "@slopus/happy-agent-base";
import type { ProviderModelCompatibilityType } from "@slopus/happy-providers";
import type { Context } from "@steve.kite/stdlib";

import { systemPromptForModel } from "./impl/systemPromptForModel.js";
import {
    DEFAULT_SYSTEM_PROMPT_IDENTITY,
    type SystemPromptIdentity,
} from "./SystemPromptIdentity.js";

const IDENTITY_MARKER = "{{identity}}";
const NAME_MARKER = "{{name}}";

/** What a system-prompt feature is built with. */
export interface SystemPromptFeatureOptions {
    /** Who the agent says it is. Defaults to Rig's own identity. */
    readonly identity?: SystemPromptIdentity;
}

/**
 * The instructions a model is written for.
 *
 * Every model is trained differently and is told how to behave in its own words, so the prompt
 * an agent runs on follows the model it is running rather than the agent. The feature reads the
 * selection from the scope it is handed, so an agent that switches models mid-conversation is
 * given the new model's prompt on the very next inference without anything else changing. A model
 * nobody has written a prompt for gets the simple one, so there is always a prompt.
 *
 * It holds no state and takes no lock: the answer depends on nothing but the model in force and
 * the identity the feature was built with, so any number of agents may ask at once.
 */
export class SystemPromptFeature implements AgentFeature {
    readonly name = "system-prompt";

    /** Who the agent says it is, substituted into whichever prompt is chosen. */
    readonly #identity: SystemPromptIdentity;

    constructor(options: SystemPromptFeatureOptions = {}) {
        this.#identity = options.identity ?? DEFAULT_SYSTEM_PROMPT_IDENTITY;
    }

    /** The prompt this model is written for, ready to use. */
    promptFor(selection: {
        model: string | undefined;
        providerKind?: ProviderModelCompatibilityType | undefined;
    }): string {
        return systemPromptForModel(selection)
            .replaceAll(NAME_MARKER, this.#identity.name.trim())
            .replace(IDENTITY_MARKER, this.#identity.prompt.trim());
    }

    readonly instructions = (_ctx: Context, scope: AgentFeatureScope): string =>
        this.promptFor({
            model: scope.agent.model,
            providerKind: scope.agent.providerKind,
        });
}
