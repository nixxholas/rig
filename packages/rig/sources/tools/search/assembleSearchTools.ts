import type { AnyDefinedTool } from "../../agent/types.js";
import { createClaudeWebSearchTool } from "./ClaudeWebSearch.js";
import { createCodexWebSearchTool } from "./CodexWebSearch.js";
import { createGeminiWebSearchTool } from "./GeminiWebSearch.js";
import { createGrokWebSearchTool } from "./GrokWebSearch.js";
import { createGrokXSearchTool } from "./GrokXSearch.js";
import type { OneOffInferenceRoute } from "./OneOffInferenceRoute.js";
import { createWebFetchTool } from "./web_fetch.js";

/** Builds the fixed ordinary search-tool array from configured provider routes. */
export function assembleSearchTools(options: {
    claudeRoutes: readonly OneOffInferenceRoute[];
    codexRoutes: readonly OneOffInferenceRoute[];
    currentRoute?: OneOffInferenceRoute;
    geminiApiKey?: string;
    grokRoutes: readonly OneOffInferenceRoute[];
}): readonly AnyDefinedTool[] {
    const currentProviderId = options.currentRoute?.provider.id;
    return [
        createWebFetchTool(options.currentRoute),
        ...(options.geminiApiKey === undefined
            ? []
            : [createGeminiWebSearchTool(options.geminiApiKey)]),
        ...(options.claudeRoutes.length === 0
            ? []
            : [
                  createClaudeWebSearchTool({
                      routes: options.claudeRoutes,
                      ...(currentProviderId === undefined ? {} : { currentProviderId }),
                  }),
              ]),
        ...(options.codexRoutes.length === 0
            ? []
            : [
                  createCodexWebSearchTool({
                      routes: options.codexRoutes,
                      ...(currentProviderId === undefined ? {} : { currentProviderId }),
                  }),
              ]),
        ...(options.grokRoutes.length === 0
            ? []
            : [
                  createGrokWebSearchTool({
                      routes: options.grokRoutes,
                      ...(currentProviderId === undefined ? {} : { currentProviderId }),
                  }),
                  createGrokXSearchTool({
                      routes: options.grokRoutes,
                      ...(currentProviderId === undefined ? {} : { currentProviderId }),
                  }),
              ]),
    ];
}
