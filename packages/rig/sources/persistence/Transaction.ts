import type { SessionDatabase } from "./database/openSessionDatabase.js";

type DrizzleTransaction = Parameters<Parameters<SessionDatabase["transaction"]>[0]>[0];

export type TX = SessionDatabase | DrizzleTransaction;
