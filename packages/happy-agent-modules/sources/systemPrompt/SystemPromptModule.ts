import type { AgentModule, AgentModuleScope } from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import { systemPromptForModel } from "./impl/systemPromptForModel.js";
import {
    DEFAULT_SYSTEM_PROMPT_IDENTITY,
    systemPromptIdentitySchema,
    type SystemPromptIdentity,
} from "./SystemPromptIdentity.js";
import {
    systemPromptSelectionSchema,
    type SystemPromptSelection,
} from "./SystemPromptSelection.js";

const IDENTITY_MARKER = "{{identity}}";
const NAME_MARKER = "{{name}}";

/** The largest prompt output accepted after identity substitution. */
export const MAX_SYSTEM_PROMPT_OUTPUT_BYTES = 1_000_000;

/** What a system-prompt module is built with. */
export const systemPromptModuleOptionsSchema = Type.Object(
    {
        /** Who the agent says it is. Defaults to Rig's own identity. */
        identity: Type.Optional(systemPromptIdentitySchema),
    },
    { additionalProperties: false },
);

/** The TypeScript type inferred from {@link systemPromptModuleOptionsSchema}. */
export type SystemPromptModuleOptions = Static<typeof systemPromptModuleOptionsSchema>;

export { systemPromptIdentitySchema, systemPromptSelectionSchema };
export type { SystemPromptSelection };

/**
 * The instructions a model is written for.
 *
 * Every model is trained differently and is told how to behave in its own words, so the prompt
 * an agent runs on follows the model it is running rather than the agent. The module reads the
 * selection from the scope it is handed, so an agent that switches models mid-conversation is
 * given the new model's prompt on the very next inference without anything else changing. A model
 * nobody has written a prompt for gets the simple one, so there is always a prompt.
 *
 * It holds no state and takes no lock: the answer depends on nothing but the model in force and
 * the identity the module was built with, so any number of agents may ask at once.
 */
export class SystemPromptModule implements AgentModule {
    readonly name = "system-prompt";

    /** Who the agent says it is, substituted into whichever prompt is chosen. */
    readonly #identity: SystemPromptIdentity;

    constructor(options: SystemPromptModuleOptions = {}) {
        if (!Value.Check(systemPromptModuleOptionsSchema, options)) {
            throw new Error("System prompt module options are invalid.");
        }
        const snapshot = structuredClone(options.identity ?? DEFAULT_SYSTEM_PROMPT_IDENTITY);
        if (!Value.Check(systemPromptIdentitySchema, snapshot)) {
            throw new Error("System prompt module options are invalid.");
        }
        this.#identity = Object.freeze(snapshot);
    }

    /** The prompt this model is written for, ready to use. */
    promptFor(selection: SystemPromptSelection): string {
        if (!Value.Check(systemPromptSelectionSchema, selection)) {
            throw new Error("System prompt model selection is invalid.");
        }
        const prompt = systemPromptForModel(selection)
            .replaceAll(NAME_MARKER, () => this.#identity.name.trim())
            .replace(IDENTITY_MARKER, () => this.#identity.prompt.trim());
        if (new TextEncoder().encode(prompt).byteLength > MAX_SYSTEM_PROMPT_OUTPUT_BYTES) {
            throw new Error("The system prompt exceeds the configured output bound.");
        }
        return prompt;
    }

    readonly instructions = (_ctx: Context, scope: AgentModuleScope): string =>
        this.promptFor({
            model: scope.agent.model,
            ...(scope.agent.providerKind === undefined
                ? {}
                : { providerKind: scope.agent.providerKind }),
        });
}
