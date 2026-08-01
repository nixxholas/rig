import type { ConfigPresence } from "../config/types.js";
import { writePresenceSelection } from "../config/writePresenceSelection.js";
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
    const selection: PresenceSelection | undefined =
        presence.current === undefined
            ? undefined
            : {
                  ...(presence.fallback === undefined
                      ? {}
                      : { fallbackPresenceId: presence.fallback }),
                  presenceId: presence.current,
                  since: now(),
                  ...(presence.until === undefined || presence.until <= now()
                      ? {}
                      : { until: presence.until }),
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
