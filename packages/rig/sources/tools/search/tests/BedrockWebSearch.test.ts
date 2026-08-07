import { describe, expect, it } from "vitest";
import { builtinModelProfiles, type ExecutorProvider } from "@slopus/rig-execution";
import type { SessionEvent, SessionTool } from "@slopus/rig-providers";

import { createBedrockWebSearchTool } from "../BedrockWebSearch.js";

/**
 * The message item Bedrock's Responses endpoint reports when Web Search grounded an answer. Its
 * sources live in `url_citation` annotations on the text rather than in the search call, which is
 * why the tool reads them back out of the provider's own response items.
 */
const GROUNDED_MESSAGE = JSON.stringify({
    type: "message",
    id: "msg_dcda8e4b477f5a1d96bfbcadefef7a77",
    role: "assistant",
    status: "completed",
    content: [
        {
            type: "output_text",
            text: "EKS added Kubernetes version rollbacks within seven days.",
            annotations: [
                {
                    type: "url_citation",
                    title: "Upgrade Amazon EKS clusters with confidence | AWS News Blog",
                    url: "https://aws.amazon.com/blogs/aws/upgrade-amazon-eks-clusters/",
                    start_index: 0,
                    end_index: 57,
                },
                {
                    type: "url_citation",
                    url: "https://aws.amazon.com/blogs/aws/aws-weekly-roundup/",
                    start_index: 0,
                    end_index: 57,
                },
            ],
        },
    ],
});

describe("bedrock_web_search", () => {
    it("keeps requests inside the AWS boundary so the default IAM policy is enough", async () => {
        const session = recordingSession([
            { type: "toolcall_start", callId: "ws_1", name: "web_search", server: true },
            { type: "text_delta", delta: "EKS added Kubernetes version rollbacks." },
            { type: "response_items", items: [GROUNDED_MESSAGE] },
            { type: "done", state: "normal" },
        ]);
        const tool = createBedrockWebSearchTool({ routes: [route("bedrock", session)] });

        await tool.execute({ query: "recent AWS launches" }, {} as never, {} as never);

        expect(session.tools).toEqual([
            { name: "web_search", server: { type: "web_search", external_web_access: false } },
        ]);
    });

    it("reads its sources from the url_citation annotations Bedrock returns", async () => {
        const session = recordingSession([
            { type: "toolcall_start", callId: "ws_1", name: "web_search", server: true },
            { type: "text_delta", delta: "EKS added Kubernetes version rollbacks." },
            { type: "response_items", items: [GROUNDED_MESSAGE] },
            { type: "done", state: "normal" },
        ]);
        const tool = createBedrockWebSearchTool({ routes: [route("bedrock", session)] });

        const result = await tool.execute(
            { query: "recent AWS launches" },
            {} as never,
            {} as never,
        );

        expect(result.citations).toEqual([
            {
                title: "Upgrade Amazon EKS clusters with confidence | AWS News Blog",
                url: "https://aws.amazon.com/blogs/aws/upgrade-amazon-eks-clusters/",
            },
            // An annotation without a title still has to be citable, so its URL stands in.
            {
                title: "https://aws.amazon.com/blogs/aws/aws-weekly-roundup/",
                url: "https://aws.amazon.com/blogs/aws/aws-weekly-roundup/",
            },
        ]);
        expect(result.answer).toBe("EKS added Kubernetes version rollbacks.");
    });

    it("reports an ungrounded answer instead of passing it off as a search result", async () => {
        const session = recordingSession([
            { type: "text_delta", delta: "I already know this one." },
            { type: "done", state: "normal" },
        ]);
        const tool = createBedrockWebSearchTool({ routes: [route("bedrock", session)] });

        await expect(
            tool.execute({ query: "recent AWS launches" }, {} as never, {} as never),
        ).rejects.toThrow('Bedrock did not search for "recent AWS launches".');
    });
});

function recordingSession(events: readonly SessionEvent[]) {
    return {
        tools: undefined as readonly SessionTool[] | undefined,
        async session(_id: string, options: { tools: readonly SessionTool[] }) {
            this.tools = options.tools;
            return {
                run: () => toAsyncIterable(events),
                destroy: async () => {},
            };
        },
    };
}

async function* toAsyncIterable(events: readonly SessionEvent[]): AsyncGenerator<SessionEvent> {
    for (const event of events) yield event;
}

function route(providerId: string, native: unknown) {
    const profile = builtinModelProfiles(providerId, "bedrock").find((candidate) =>
        candidate.id.startsWith("openai/"),
    );
    if (profile === undefined) throw new Error("Bedrock has no OpenAI profile to search with.");
    const provider = {
        id: providerId,
        native: async () => native,
        profiles: [profile],
    } as unknown as ExecutorProvider;
    return { profile, provider };
}
