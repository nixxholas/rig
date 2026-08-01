import type { ConfigPresenceState } from "../config/types.js";
import { BUILT_IN_PRESENCES } from "./builtInPresences.js";
import type { Presence } from "./types.js";

/**
 * Presences are fixed at load time: the two built-in states, with configured overrides applied,
 * followed by whatever custom states the user defined.
 */
export function resolvePresences(
    states: Readonly<Record<string, ConfigPresenceState>> = {},
): readonly Presence[] {
    const builtIn = BUILT_IN_PRESENCES.map((presence) =>
        applyOverrides(presence, states[presence.id]),
    );
    const custom = Object.entries(states)
        .filter(([id]) => !BUILT_IN_PRESENCES.some((presence) => presence.id === id))
        .map(([id, state]) =>
            applyOverrides(
                {
                    answerWaitMs: null,
                    emoji: "•",
                    id,
                    prompt: "",
                    title: id,
                },
                state,
            ),
        );
    return [...builtIn, ...custom];
}

function applyOverrides(presence: Presence, state: ConfigPresenceState | undefined): Presence {
    if (state === undefined) return presence;
    return {
        answerWaitMs: state.answerWaitMs === undefined ? presence.answerWaitMs : state.answerWaitMs,
        emoji: state.emoji ?? presence.emoji,
        id: presence.id,
        prompt: state.prompt ?? presence.prompt,
        title: state.title ?? presence.title,
    };
}
