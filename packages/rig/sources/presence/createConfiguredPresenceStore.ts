import type { ConfigPresence } from "../config/types.js";
import { writePresenceSelection } from "../config/writePresenceSelection.js";
import { ONLINE_PRESENCE_ID } from "./builtInPresences.js";
import { PresenceStore, type PresenceSelection } from "./PresenceStore.js";
import { resolvePresences } from "./resolvePresences.js";

/**
 * The presence the daemon runs with: the states from configuration, the one the user last chose,
 * and a writer that remembers the next choice across restarts.
 */
export function createConfiguredPresenceStore(
    presence: ConfigPresence,
    options: { now?: () => number; persist?: (selection: PresenceSelection) => Promise<void> } = {},
): PresenceStore {
    const now = options.now ?? (() => Date.now());
    const currentTime = now();
    const expired = presence.until !== undefined && presence.until <= currentTime;
    const selection: PresenceSelection | undefined =
        presence.current === undefined
            ? undefined
            : {
                  ...(!expired && presence.fallback !== undefined
                      ? { fallbackPresenceId: presence.fallback }
                      : {}),
                  presenceId: expired
                      ? (presence.fallback ?? ONLINE_PRESENCE_ID)
                      : presence.current,
                  since: expired ? presence.until! : currentTime,
                  ...(expired || presence.until === undefined ? {} : { until: presence.until }),
              };
    return new PresenceStore({
        now,
        persist:
            options.persist ??
            ((chosen) =>
                writePresenceSelection({
                    ...(chosen.fallbackPresenceId === undefined
                        ? {}
                        : { fallbackPresenceId: chosen.fallbackPresenceId }),
                    presenceId: chosen.presenceId,
                    ...(chosen.until === undefined ? {} : { until: chosen.until }),
                })),
        presences: resolvePresences(presence.states),
        ...(selection === undefined ? {} : { selection }),
    });
}
