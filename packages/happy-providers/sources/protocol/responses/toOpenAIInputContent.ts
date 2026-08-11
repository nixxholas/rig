import type {
    ResponseInputImage,
    ResponseInputText,
} from "openai/resources/responses/responses.js";

import type { SessionInputBlock, SessionOutputBlock } from "@/core/SessionContext.js";

export function toOpenAIInputContent(
    content: readonly (SessionInputBlock | SessionOutputBlock)[],
): string | Array<ResponseInputText | ResponseInputImage> {
    if (content.length === 1 && content[0]?.type === "text") return content[0].text;
    return content.map((block) =>
        block.type === "text"
            ? { type: "input_text", text: block.text }
            : {
                  type: "input_image",
                  detail: "auto",
                  image_url: `data:${block.mimeType};base64,${block.data}`,
              },
    );
}
