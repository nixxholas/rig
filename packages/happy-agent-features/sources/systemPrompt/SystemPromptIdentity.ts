/** Who the agent says it is, substituted into the model's prompt wherever it names itself. */
export interface SystemPromptIdentity {
    /** The name the agent answers to, replacing every `{{name}}` marker. */
    name: string;
    /** The sentence that opens the prompt, replacing the first `{{identity}}` marker. */
    prompt: string;
}

/** The identity a prompt carries when the host never names another. */
export const DEFAULT_SYSTEM_PROMPT_IDENTITY: SystemPromptIdentity = {
    name: "Rig",
    prompt: "You are Rig, built by Happy",
};
