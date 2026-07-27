import { connectRig, type RigGroupsConnection } from "./connectRig.js";
import type { GroupDelta, GroupsState, ProjectGroup } from "./GroupElement.js";

export interface ConnectGroupsOptions {
    endpoint: string;
    token: string;
    onChange: (projects: readonly ProjectGroup[], state: GroupsState) => void;
    onDelta?: (delta: GroupDelta) => void;
    onError?: (error: unknown) => void;
    fetch?: typeof globalThis.fetch;
}

export type GroupsConnection = RigGroupsConnection;

/** Compatibility wrapper for callers that need only the catalog stream. */
export function connectGroups(options: ConnectGroupsOptions): GroupsConnection {
    const rig = connectRig({
        endpoint: options.endpoint,
        token: options.token,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
    });
    const subscription = rig.connectGroups({
        onChange: options.onChange,
        ...(options.onDelta === undefined ? {} : { onDelta: options.onDelta }),
        ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    return {
        projects: subscription.projects,
        remoteTerminals: subscription.remoteTerminals,
        state: subscription.state,
        close: () => {
            subscription.close();
            rig.close();
        },
    };
}
