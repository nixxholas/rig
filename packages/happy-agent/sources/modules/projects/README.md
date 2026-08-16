# Projects and workspaces host layer

This directory is the host half of projects and workspaces. The catalogs in
`@slopus/happy-agent-modules` own everything durable — which folder is a project, which branch a
workspace sits on, how far its setup got, what order they appear in. This owns everything those
records describe but cannot do: canonical paths, managed directories, Git worktrees, clones, setup
commands, file replication, folder removal, avatar bytes, and the background work that carries a
reservation through to a checkout somebody can work in.

`ProjectWorkspaceService` is the whole public entry point. Everything else in this directory is one
coherent operation it composes, and each of those is usable on its own.

## Where the line falls

A person's request never blocks on Git. Reserving a workspace is a database write that settles
immediately and hands back a workspace with its branch, folder key and path already decided; making
the worktree, replicating files and running setup commands happens afterwards on a background
lifetime. The same rule holds in the other direction: archiving a workspace is the whole decision
and is made at once, while removing its folder is separate work that may fail without giving the
workspace back.

Renaming works the same way. The name is stored first, because that is what the person asked for,
and the Git branch follows under the project's lock. If Git refuses, the name stands and the
recorded branch goes back to the one Git actually has.

## Lifetimes

Background initialization, sync passes, filesystem watches, branch moves, folder cleanup and avatar
maintenance each get their own named context derived from the application root — never the HTTP
request, tool call or turn that triggered them. `close` stops all of them and waits for the work
already in flight.

Those contexts carry the logger and the tracer from the root, but nothing an agent installed later.
Work that reaches the catalogs needs the agent database, so the caller that owns it passes
`extendBackgroundContext` and it is attached once per lifetime rather than once per call.

## Managed directories

Cloned projects live under `getManagedProjectsDirectory`, workspaces under
`getManagedWorkspacesDirectory`. Both take an absolute-path override from the environment, and both
refuse a relative one so the location cannot depend on the process working directory. A workspace's
path is `<managed workspaces>/<project storage key>/<workspace storage key>`, and once the
reservation has settled on it that path is authoritative — moving the root afterwards only affects
workspaces created later.

## When Git cannot help

A project Git cannot cut a worktree from still gets workspaces: the folder is copied instead, and
the workspace records `kind: "directory"`. Archival treats the two differently by default. A
worktree is rebuildable from the repository, so its folder goes; a copied folder is the only place
that work exists, so it stays. Both are settings.

## Tests

`packages/happy-agent/tests/projects/` drives this against real Git repositories in temporary
directories and real catalogs over an in-memory database. Nothing about Git is mocked, because the
behaviors worth testing — branch collisions, worktree adoption, prune, resuming onto a promised
base commit — are Git's.
