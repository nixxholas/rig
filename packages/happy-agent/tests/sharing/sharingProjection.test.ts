import { Value } from "@sinclair/typebox/value";
import { MurmurService, ProfileModule, type MurmurClientFacade } from "@slopus/happy-agent-modules";
import { murmurMigrations } from "@slopus/happy-agent-modules";
import { withAgentDatabase } from "@slopus/happy-agent-base";
import { createRootContext, type Context, type RootContext } from "@steve.kite/stdlib";
import { drizzle } from "drizzle-orm/sqlite-proxy";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

import {
    createSharingInvitationResponseSchema,
    sharingChangedEventSchema,
    sharingOutgoingContactRequestResponseSchema,
    sharingSnapshotSchema,
} from "../../../rig/sources/protocol/SharingProtocol.js";

describe("what sharing puts on the wire", () => {
    it("projects a snapshot, an invitation, and an outgoing request into the Rig protocol", async () => {
        const world = await sharingWorld();
        try {
            await world.service.bindProfile(world.ctx, world.person.id);

            const snapshot = await world.service.snapshot(world.ctx);
            // Nothing here shares a folder any more, and a client still reads the field.
            const wire = { ...snapshot, folderShares: [] };
            expect(Value.Check(sharingSnapshotSchema, wire)).toBe(true);
            expect(wire).toMatchObject({
                connection: "connecting",
                contacts: [{ identity: encode(2), profile: PROFILE, status: "active" }],
                incomingRequests: [{ id: "request-1", identity: encode(3) }],
                profileId: world.person.id,
            });

            const invitation = await world.service.createInvitation(world.ctx);
            expect(Value.Check(createSharingInvitationResponseSchema, invitation)).toBe(true);

            const request = await world.service.requestContact(world.ctx, encode(9));
            expect(Value.Check(sharingOutgoingContactRequestResponseSchema, { request })).toBe(
                true,
            );

            // Every change the module announces is an event a Rig client can already read, once
            // the host renames it to the name the client knows.
            expect(world.published.length).toBeGreaterThan(0);
            for (const event of world.published) {
                expect(
                    Value.Check(sharingChangedEventSchema, { ...event, type: "sharing_changed" }),
                ).toBe(true);
            }
        } finally {
            await world.close();
        }
    });

    it("shows a peer profile this build cannot read as no profile at all", async () => {
        const world = await sharingWorld({ contactProfile: { greeting: "from the future" } });
        try {
            await world.service.bindProfile(world.ctx, world.person.id);

            const snapshot = await world.service.snapshot(world.ctx);
            expect(Value.Check(sharingSnapshotSchema, { ...snapshot, folderShares: [] })).toBe(
                true,
            );
            expect(snapshot.contacts[0]?.profile).toBeNull();
        } finally {
            await world.close();
        }
    });

    it("refuses to reject a request nobody sent", async () => {
        const world = await sharingWorld();
        try {
            await world.service.bindProfile(world.ctx, world.person.id);

            await expect(world.service.rejectContact(world.ctx, "no-such-request")).rejects.toThrow(
                "Contact request not found.",
            );
        } finally {
            await world.close();
        }
    });
});

const PROFILE = {
    createdAt: 1_700_000_000_000,
    email: "ada@example.com",
    id: "adalovelace",
    name: "Ada Lovelace",
    parentInstanceId: "installation1",
    updatedAt: 1_700_000_000_000,
    version: 1,
} as const;

/** A 32-byte value, which is what every Murmur identity, session, and invitation is. */
function bytes(seed: number): Uint8Array {
    return Uint8Array.from({ length: 32 }, (_value, index) => (seed * 31 + index) % 256);
}

function encode(seed: number): string {
    return Buffer.from(bytes(seed)).toString("base64url");
}

/**
 * A live service over a scripted client.
 *
 * The relay is the one thing a test cannot have, and it is also the only thing the service
 * reaches for, so scripting the client covers every path that matters here.
 */
async function sharingWorld(options: { readonly contactProfile?: unknown } = {}) {
    const sqlite = new DatabaseSync(":memory:");
    const database = drizzle(async (query, params, method) => {
        const statement = sqlite.prepare(query);
        if (method === "run") {
            statement.run(...params);
            return { rows: [] };
        }
        if (method === "get") {
            const row = statement.get(...params);
            return { rows: row === undefined ? [] : [row] };
        }
        if (method === "values") {
            statement.setReturnArrays(true);
            return { rows: statement.all(...params) };
        }
        return { rows: statement.all(...params) };
    });
    const rootContext = withAgentDatabase(createRootContext(), database) as RootContext;
    const ctx = rootContext.named("sharing-projection-test");
    // Sharing reads the person from the real profile catalog, so this world has one.
    const profiles = new ProfileModule();
    for (const [, migrate] of [...murmurMigrations, ...profiles.migrations]) {
        await migrate(ctx, database);
    }
    profiles.open(PROFILE.parentInstanceId);
    const person = await profiles.create(ctx, { email: PROFILE.email, name: PROFILE.name });

    const carried = options.contactProfile ?? { profile: PROFILE, version: 1 };
    const client = {
        identity: bytes(1),
        acceptContact: async () => undefined,
        close: () => undefined,
        contactRequests: async () => [
            { id: "request-1", identity: bytes(3), profile: carried, sessionId: bytes(4) },
        ],
        contacts: async () => [{ identity: bytes(2), profile: carried, status: "active" }],
        createInvitation: async () => bytes(5),
        outgoingContactRequests: async () => [],
        rejectContact: async () => undefined,
        removeContact: async () => undefined,
        resolveInvitation: async () => ({ identityKey: bytes(6) }),
        requestContact: async () => ({ id: bytes(7) }),
        // Nothing connects: the loop is never started, so the connection stays "connecting".
        synchronize: async () => undefined,
        sync: async () => undefined,
    } as unknown as MurmurClientFacade;

    const published: { readonly type: string }[] = [];
    const service = new MurmurService({
        client,
        profile: profiles,
        publish: (_publishCtx, event) => {
            published.push(event);
        },
        rootContext,
    });
    return {
        ctx: ctx as Context,
        person,
        published,
        service,
        close: async () => {
            await service.close(ctx);
            sqlite.close();
        },
    };
}
