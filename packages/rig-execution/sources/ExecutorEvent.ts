import type { SessionEvent } from "@slopus/happy-providers";

import type { ExecutorSelection } from "@/ExecutorModelProfile.js";

export type ExecutorEvent =
    | SessionEvent
    | {
          type: "reset_required";
          current: ExecutorSelection;
          requested: ExecutorSelection;
          message: string;
      };
