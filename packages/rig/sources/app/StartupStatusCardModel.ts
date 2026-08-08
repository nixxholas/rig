export interface StartupStatusCardUsageWindow {
    capturedAt?: number;
    percentLeft: number;
    resetsIn?: string;
}

export interface StartupStatusCardUsage {
    fiveHour?: StartupStatusCardUsageWindow;
    weekly?: StartupStatusCardUsageWindow;
}

export interface StartupStatusCardModel {
    access: string;
    environment: string;
    fast: boolean;
    githubAvailable?: boolean;
    model: string;
    provider: string;
    reasoning: string;
    session: "New session" | "Resumed";
    usage?: StartupStatusCardUsage;
    version: string;
    workspace: string;
}
