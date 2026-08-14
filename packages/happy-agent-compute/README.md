# @slopus/happy-agent-compute

The machine a Happy agent works on: a filesystem, a shell, and the boundary around both.

An agent that can only think is not much use. It has to read a file, run a build, start a server, and
see what happened. This package is the thing underneath all of that — and, just as importantly, the
thing that decides what the agent is not allowed to touch.

## Compute

A `Compute` is one place the agent can work, and it bundles everything needed to work there:

```ts
interface Compute {
    readonly kind: ComputeKind; // "host" | "just-bash" | "docker"
    readonly cwd: string;
    readonly fs: ComputeFileSystem;
    readonly shell: ComputeShell;
    readonly permissions: ComputePermissions;
    dispose(ctx: Context): Promise<void>;
}
```

The same four members mean the same thing in every backend, so code written against `Compute` does
not care which one it got. `dispose()` ends everything that compute started.

## The three backends

**Host** — the real filesystem and shell of the machine. Commands run as real processes under a real
sandbox: Seatbelt on macOS, Bubblewrap on Linux. This is what a person running Rig on their laptop
gets.

```ts
const compute = createHostCompute({ cwd, permissions, ... });
```

**Docker** — a filesystem and shell inside a container, either one the caller attached to by name or
one this package created. The sandbox and the managed network are rebuilt inside the container.

```ts
const compute = createDockerCompute({
    client,
    docker: { image, workingDirectory },
    permissions,
    sessionId,
});
```

**Just-bash** — a bash implementation with no host processes at all, backed either by an in-memory
filesystem or by one real folder. It is fast, it is deterministic, and nothing it does can escape the
filesystem it was given, which makes it the right choice for tests and for the gym.

```ts
const compute = createJustBashCompute({ storage: "memory" });
const compute = createJustBashCompute({ storage: "folder", folder: "/some/path" });
```

## Permissions

`ComputePermissions` is asked, never remembered:

```ts
interface ComputePermissions {
    mode(): ComputePermissionMode; // "read_only" | "workspace_write" | "auto" | "full_access"
    protectedPaths(): readonly string[];
    revision(): number;
}
```

The mode is a function because it genuinely changes while the agent is running — a person switches
modes mid-conversation, and a reviewed action runs one command with full access and restores the
mode immediately afterwards. Every check asks again.

`revision()` exists because starting a command is not instantaneous. The backend reads the mode, then
loads configuration, opens network resources, and builds a sandbox before anything is spawned. If the
person narrowed permissions during that window, the command must not start under the mode it was
planned with, so the backend records the revision when it decides and calls
`assertComputePermissionRevision` immediately before the irreversible step.

## The sandbox

`sources/sandbox/` builds the boundary a restricted command runs inside: read and write containment
that follows symlinks to their real target, protected Git control paths, a read-only placeholder over
the project configuration that grants network access, a private `/tmp`, and an empty `/proc` where
the platform allows it. `sources/network/` is the other half — a command-scoped proxy, with
unguessable per-command authentication, that carries the egress the project's policy allows and
refuses everything else.

## Processes

`sources/processes/` is the process machinery the host backend runs on, and it is what makes the
shell semantics in master plan 8 work: delta-only reads, stdin into a running session, graceful-then-
forceful tree kill, process-group reaping after a launcher exits, and a timeout that backgrounds a
command rather than killing it.

That last one is worth stating plainly, because it is the opposite of what most tools do. A command
that outruns its timeout is not killed. It is handed back as a background session the agent can keep
reading from, write to, and stop when it decides to.
