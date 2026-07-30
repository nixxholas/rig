# Master plan 8: sandbox environments

Rig's restricted command modes depend on a small, explicit security environment.
We support the environment well instead of pretending that an incomplete
environment is secure.

On macOS, Rig assumes the system Seatbelt sandbox is available through
`/usr/bin/sandbox-exec`. On Linux, Rig requires Bubblewrap and `socat`. A
Docker image or existing container used as a Rig execution environment must
also contain Bubblewrap and `socat`, allow the nested namespaces Bubblewrap
needs, and provide a host bind-mounted working directory when host-to-container
Unix sockets are required.

Restricted execution must fail closed with a human-readable explanation when
one of these requirements is missing. Full access does not claim to provide the
restricted sandbox boundary.

Managed HTTP and SOCKS proxy access must work for native commands and
Docker-backed commands under the same project and global network policy. The
proxy is created only for the command, is not published as a generally
available TCP service, and reaches a Docker sandbox through temporary Unix
sockets shared by the working-directory bind mount. Shared bridge sockets must
live beneath a root that every restricted command sees through a read-only
mount, so a neighboring command cannot rename or replace a live socket.
Connections must also require unguessable command-scoped authentication, and a
restricted Docker command must not inherit the container's parent process
table or another command's temporary process-control state. Restricted commands
receive a private `/tmp`. When nested procfs mounting is unavailable, an empty
private `/proc` is the secure fallback.

The repository's root `rig.toml` is part of the sandbox boundary because it can
grant managed network access to later commands. Restricted commands must see it
read-only. When it does not exist, command startup must atomically reserve the
path with a trusted empty placeholder and mount that placeholder read-only, so
concurrent commands cannot create policy for themselves or for the next
command. Rig removes its unchanged placeholder after the command finishes.

This plan is complete when:

1. startup and command errors clearly identify a missing or unusable sandbox
   dependency;
2. native macOS and Linux restricted commands enforce their configured
   filesystem and network boundaries;
3. a real Docker-backed session can reach an allowed HTTP destination through
   the managed proxy while direct unconfigured network access remains blocked;
4. proxy processes, socket bridges, and temporary directories are removed when
   commands finish or fail;
5. an existing or initially absent root `rig.toml` remains immutable across
   concurrent restricted commands.
