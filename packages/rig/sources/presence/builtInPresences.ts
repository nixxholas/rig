import type { Presence } from "./types.js";

export const ONLINE_PRESENCE_ID = "online";
export const AWAY_PRESENCE_ID = "away";

export const ONLINE_PRESENCE: Presence = {
    answerWaitMs: null,
    emoji: "🟢",
    id: ONLINE_PRESENCE_ID,
    prompt: "The user is at the keyboard and can answer questions right away.",
    title: "Online",
};

export const AWAY_PRESENCE: Presence = {
    answerWaitMs: 0,
    emoji: "🌙",
    id: AWAY_PRESENCE_ID,
    prompt: "The user is away and cannot be reached. Do not wait for an answer. Decide with your best judgement, keep working, and record anything the user should look at later.",
    title: "Away",
};

export const BUILT_IN_PRESENCES: readonly Presence[] = [ONLINE_PRESENCE, AWAY_PRESENCE];
