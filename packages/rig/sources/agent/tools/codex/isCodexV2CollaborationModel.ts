/**
 * Which generation of Codex collaboration tools a model speaks. The two generations name their
 * spawn tool the same way but differ in namespace and arguments, so a model has to be matched with
 * the one it was trained on.
 *
 * The gym model stands in for a current Codex model, so it speaks the current generation.
 */
export function isCodexV2CollaborationModel(modelId: string, providerName?: string): boolean {
    return (
        providerName !== "bedrock" &&
        (modelId === "openai/gpt-5.6-sol" ||
            modelId === "openai/gpt-5.6-terra" ||
            modelId === "openai/gym")
    );
}
