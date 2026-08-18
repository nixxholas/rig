# Profile

The one person this installation belongs to. A profile is what sharing puts on the wire so a
contact sees a name rather than a key, and what a project records about who created it.

One installation is one person, so there is exactly one profile here. Creating a second is
refused with a clear message rather than silently ignored, and no method takes a list.

```ts
import { ProfileModule } from "@slopus/happy-agent-modules";

const profile = new ProfileModule({
    listener: {
        onEvent: async (ctx, event) => {
            await events.record(ctx, { type: "profile.changed", payload: event });
        },
    },
});
// The agent this installation runs as is the machine the profile records.
profile.open(rootAgentId);
```

`open(agentId)` names the installation. It is separate from the constructor because the agent
only exists once the module system has started, and a profile records the machine it was made on
so another machine reading it later knows it may not speak for that person. Before `open`,
`isLocal` is false and `create` and `update` refuse.

## Direct operations

- `get(ctx)` returns the profile, or nothing when nobody has been named.
- `getById(ctx, profileId)` returns the same profile when the id matches, for a caller holding
  one that wants to confirm it still exists.
- `isLocal(ctx, profileId)` says whether this installation owns that profile and may act as that
  person. [Murmur](../murmur/README.md) is given this catalog and asks it directly, so that
  decision is made in one place.
- `create(ctx, { email, name })` names the person. A second call throws
  "This installation already has a profile."
- `update(ctx, profileId, { email?, name? })` increments `version`, moves `updatedAt`, and
  returns nothing when the id is unknown. An installation that does not own the profile is
  refused.

Names and addresses are validated with TypeBox before anything is written. The name pattern
refuses control characters and bidirectional overrides, so a name cannot make a display lie
about which text belongs to it.

## Events

Every create and update publishes a `profile_changed` event carrying `{ profileId, version }`.
The host is what puts it on its event stream; the module only says that it happened.

## Storage

Migration `001-profile` creates `happy_agent_profile`, a single-row table holding the profile as
validated JSON. Nothing else in the module is durable.

## Deliberately not here

- **Photos.** `RigProfile` carries an optional photo, and the wire schema still accepts one so
  responses stay valid, but nothing here stores or serves image bytes. Adding it means a place
  to put the bytes and a re-encoding step, and neither exists yet.
- **Replication.** Legacy Rig let a parent installation push a profile to a secondary. One
  installation, one person, one machine: there is nobody to replicate to.
