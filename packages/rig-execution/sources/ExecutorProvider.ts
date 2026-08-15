import type { BaseProvider, SessionTool } from "@slopus/happy-providers";

import type { ExecutorModelProfile } from "@/ExecutorModelProfile.js";
import type { ProfilePromptContext, ServiceTier } from "@/types.js";
import type { ExecutorImageGeneration } from "@/ExecutorImageGeneration.js";

export interface ExecutorProvider {
    destroy?(): Promise<void> | void;
    extendProfilePromptContext?: (
        context: ProfilePromptContext,
    ) => ProfilePromptContext | Promise<ProfilePromptContext>;
    id: string;
    imageGeneration?: ExecutorImageGeneration;
    isolated?: () => ExecutorProvider;
    native: BaseProvider | ((profile: ExecutorModelProfile) => Promise<BaseProvider>);
    nativeKey?: (profile: ExecutorModelProfile) => string;
    profiles: readonly ExecutorModelProfile[];
    serviceTiers?: readonly ServiceTier[];
    sessionId?: string;
}
