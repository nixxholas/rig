import {
    agentEnvironment,
    agentEnvironmentSchema,
    type AgentBaseAcceptedMessage,
    type AgentModule,
    type AgentModuleAction,
    type AgentModuleScope,
} from "@slopus/happy-agent-base";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { Context } from "@steve.kite/stdlib";

import type { ComputeResolver } from "../compute/ComputeResolver.js";
import type { AgentsMdSnapshot } from "./AgentsMd.js";
import {
    AgentsMdInstructions,
    agentsMdGlobalInstructionsReaderSchema,
    systemPromptComputeResolverSchema,
    type AgentsMdGlobalInstructionsReader,
} from "./impl/agentsMdInstructions.js";
import {
    assembleEnvironmentPrompt,
    formatAvailableModels,
} from "./impl/assembleEnvironmentPrompt.js";
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
import {
    MAX_SYSTEM_PROMPT_AVAILABLE_MODEL_FIELD_LENGTH,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS,
    systemPromptAvailableModelSchema,
    systemPromptAvailableModelsSchema,
    type SystemPromptAvailableModel,
    type SystemPromptAvailableModels,
} from "./SystemPromptAvailableModel.js";

const IDENTITY_MARKER = "{{identity}}";
const NAME_MARKER = "{{name}}";
const AGENTS_MD_OUTPUT_TRUNCATION_NOTICE =
    "[Some AGENTS.md instruction content was omitted to stay within the system prompt byte limit.]";
const INVALID_MODULE_OPTIONS_ERROR = "System prompt module options are invalid.";
const INVALID_IDENTITY_ERROR = "System prompt identity is invalid.";
const INVALID_AVAILABLE_MODELS_ERROR = "System prompt available models are invalid.";
const AVAILABLE_MODELS_BYTE_BOUND_ERROR =
    "System prompt available models exceed the configured UTF-8 byte bound.";

/** The largest prompt output accepted after identity substitution. */
export const MAX_SYSTEM_PROMPT_OUTPUT_BYTES = 1_000_000;

/** What a system-prompt module is built with. */
export const systemPromptModuleOptionsSchema = Type.Object(
    {
        /** Who the agent says it is. Defaults to Rig's own identity. */
        identity: Type.Optional(systemPromptIdentitySchema),
        /**
         * The provider/model routes the host offers to agents. The environment section prints
         * only their name, model ID, and provider ID.
         */
        availableModels: Type.Optional(systemPromptAvailableModelsSchema),
        /** Resolves the current agent's compute for project instruction discovery. */
        compute: Type.Optional(systemPromptComputeResolverSchema),
        /** Reads the host-owned global AGENTS.md document on every inference. */
        globalInstructions: Type.Optional(agentsMdGlobalInstructionsReaderSchema),
    },
    { additionalProperties: false },
);

const systemPromptModuleDiagnosticOptionsSchema = Type.Object(
    {
        identity: Type.Optional(Type.Unknown()),
        availableModels: Type.Optional(Type.Unknown()),
        compute: Type.Optional(Type.Unknown()),
        globalInstructions: Type.Optional(Type.Unknown()),
    },
    { additionalProperties: false },
);
type SystemPromptModuleDiagnosticOptions = Static<typeof systemPromptModuleDiagnosticOptionsSchema>;

/** The TypeScript type inferred from {@link systemPromptModuleOptionsSchema}. */
export type SystemPromptModuleOptions = Omit<
    Static<typeof systemPromptModuleOptionsSchema>,
    "compute" | "globalInstructions"
> & {
    readonly compute?: ComputeResolver;
    readonly globalInstructions?: AgentsMdGlobalInstructionsReader;
};

export {
    agentsMdGlobalInstructionsReaderSchema,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODEL_FIELD_LENGTH,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES,
    MAX_SYSTEM_PROMPT_AVAILABLE_MODELS,
    systemPromptAvailableModelSchema,
    systemPromptAvailableModelsSchema,
    systemPromptIdentitySchema,
    systemPromptSelectionSchema,
};
export type { SystemPromptSelection };
export type { SystemPromptAvailableModel, SystemPromptAvailableModels };
export type { AgentsMdGlobalInstructionsReader };

/**
 * The instructions a model is written for.
 *
 * Every model is trained differently and is told how to behave in its own words, so the prompt
 * an agent runs on follows the model it is running rather than the agent. The module reads the
 * selection from the scope it is handed, so an agent that switches models mid-conversation is
 * given the new model's prompt on the very next inference without anything else changing. A model
 * nobody has written a prompt for gets the simple one, so there is always a prompt.
 *
 * It holds only immutable constructor data and takes no lock: the answer depends on the model in
 * force, the attached environment, and those constructor values, so any number of agents may ask
 * at once.
 */
export class SystemPromptModule implements AgentModule {
    readonly name = "system-prompt";

    /** Who the agent says it is, substituted into whichever prompt is chosen. */
    readonly #identity: SystemPromptIdentity;
    /** The bounded host-supplied model catalog rendered in the environment section. */
    readonly #availableModels: readonly SystemPromptAvailableModel[];
    /** Live AGENTS.md discovery and durable change-notice behavior. */
    readonly #agentsMd: AgentsMdInstructions;

    constructor(options: SystemPromptModuleOptions = {}) {
        if (!Value.Check(systemPromptModuleOptionsSchema, options)) {
            throw invalidModuleOptionError(options);
        }
        const snapshot = structuredClone(options.identity ?? DEFAULT_SYSTEM_PROMPT_IDENTITY);
        if (!Value.Check(systemPromptIdentitySchema, snapshot)) {
            throw new Error(INVALID_IDENTITY_ERROR);
        }
        this.#identity = Object.freeze(snapshot);
        const availableModels = structuredClone(options.availableModels ?? []);
        if (!Value.Check(systemPromptAvailableModelsSchema, availableModels)) {
            throw new Error(INVALID_AVAILABLE_MODELS_ERROR);
        }
        if (
            new TextEncoder().encode(formatAvailableModels(availableModels)).byteLength >
            MAX_SYSTEM_PROMPT_AVAILABLE_MODELS_BYTES
        ) {
            throw new Error(AVAILABLE_MODELS_BYTE_BOUND_ERROR);
        }
        this.#availableModels = Object.freeze(availableModels.map((model) => Object.freeze(model)));
        this.#agentsMd = new AgentsMdInstructions(options.compute, options.globalInstructions);
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

    /** Read the current global, security, and project AGENTS.md snapshot. */
    async readAgentsMd(ctx: Context, agentId: string): Promise<AgentsMdSnapshot | undefined> {
        return await this.#agentsMd.read(ctx, agentId);
    }

    /**
     * Read the current AGENTS.md context formatted as the same instruction text every model
     * receives, or `undefined` when there is none. The automatic permission reviewer appends this
     * after its guardian policy so a review sees the project's own intent, reread every time.
     */
    async readAgentsMdInstructions(ctx: Context, agentId: string): Promise<string | undefined> {
        return await this.#agentsMd.readFormatted(ctx, agentId);
    }

    readonly instructions = async (ctx: Context, scope: AgentModuleScope): Promise<string> => {
        const prompt = this.promptFor({
            model: scope.agent.model,
            ...(scope.agent.providerKind === undefined
                ? {}
                : { providerKind: scope.agent.providerKind }),
        });
        const environment = agentEnvironment(ctx);
        const sections = [prompt];
        if (environment !== undefined) {
            if (!Value.Check(agentEnvironmentSchema, environment)) {
                throw new Error("The agent environment is invalid.");
            }
            sections.push(
                assembleEnvironmentPrompt({
                    environment,
                    availableModels: this.#availableModels,
                }),
            );
        }
        const agentsMdInstructions = await this.#agentsMd.instructions(ctx, scope);
        const promptBeforeAgentsMd = sections.join("\n\n");
        const agentsMdBudget =
            MAX_SYSTEM_PROMPT_OUTPUT_BYTES -
            new TextEncoder().encode(promptBeforeAgentsMd).byteLength -
            (agentsMdInstructions.length === 0 ? 0 : 2);
        const boundedAgentsMd = truncateUtf8WithNotice(agentsMdInstructions, agentsMdBudget);
        if (boundedAgentsMd.length > 0) sections.push(boundedAgentsMd);
        const fullPrompt = sections.join("\n\n");
        if (new TextEncoder().encode(fullPrompt).byteLength > MAX_SYSTEM_PROMPT_OUTPUT_BYTES) {
            throw new Error("The system prompt exceeds the configured output bound.");
        }
        return fullPrompt;
    };

    readonly beforeTurn = async (
        ctx: Context,
        scope: AgentModuleScope,
    ): Promise<readonly AgentModuleAction[] | undefined> =>
        await this.#agentsMd.beforeTurn(ctx, scope);

    readonly messageAcceptedTransact = async (
        ctx: Context,
        scope: AgentModuleScope,
        accepted: AgentBaseAcceptedMessage,
    ): Promise<void> => await this.#agentsMd.messageAcceptedTransact(ctx, scope, accepted);
}

function invalidModuleOptionError(value: unknown): Error {
    if (!Value.Check(systemPromptModuleDiagnosticOptionsSchema, value)) {
        return new Error(INVALID_MODULE_OPTIONS_ERROR);
    }
    const options = value as SystemPromptModuleDiagnosticOptions;
    if (
        options.identity !== undefined &&
        !Value.Check(systemPromptIdentitySchema, options.identity)
    ) {
        return new Error(INVALID_IDENTITY_ERROR);
    }
    if (
        options.availableModels !== undefined &&
        !Value.Check(systemPromptAvailableModelsSchema, options.availableModels)
    ) {
        return new Error(INVALID_AVAILABLE_MODELS_ERROR);
    }
    return new Error(INVALID_MODULE_OPTIONS_ERROR);
}

function truncateUtf8WithNotice(value: string, maxBytes: number): string {
    const encoder = new TextEncoder();
    if (encoder.encode(value).byteLength <= maxBytes) return value;
    if (maxBytes <= 0) return "";

    const suffix = `\n\n${AGENTS_MD_OUTPUT_TRUNCATION_NOTICE}`;
    const suffixBytes = encoder.encode(suffix).byteLength;
    if (suffixBytes >= maxBytes)
        return decodeUtf8Prefix(AGENTS_MD_OUTPUT_TRUNCATION_NOTICE, maxBytes);
    return `${decodeUtf8Prefix(value, maxBytes - suffixBytes)}${suffix}`;
}

function decodeUtf8Prefix(value: string, maxBytes: number): string {
    if (maxBytes <= 0) return "";
    const bytes = new TextEncoder().encode(value);
    let end = Math.min(maxBytes, bytes.byteLength);
    const decoder = new TextDecoder("utf-8", { fatal: true });
    while (end > 0) {
        try {
            return decoder.decode(bytes.subarray(0, end));
        } catch {
            end -= 1;
        }
    }
    return "";
}
