# Master plan 14: Slots

## Big picture

The Happy app has fixed UI locations called slots, and agents can plug content
into them. Rig owns the slots: it stores every entry, exposes the API that
agents and the app use, serves webapp content, and pushes changes to the
client. Rig only verifies types — it does not judge content.

The slots, as Happy renders them:

- The status line to the right of speed/permissions under the composer.
- Above the input itself.
- The workspace/project title.
- The sidebar menu.

Content types:

1. Text — markdown with URL support.
2. Button — an action: send a message to the current chat, open a webapp
   (rendered like the web preview), send a message to a specific chat, draft a
   message in a specific chat, or start a new chat in a workspace/project with
   a model/effort/prompt.

Every entry has a scope — everywhere, project, workspace, or session — and a
slot can hold multiple entries; the app renders all of them or lets the user
switch between them.

Every entry records its author agent, a description (what it is), and a
purpose (why it exists), so anyone in the system can figure out why it was
created and find the conversation about it.

Webapps live in a webapp folder in the user data — the `<home>/Happy` folders —
and rig serves them the way the html preview is served. A webapp is created by
importing a folder into the app; no agent writes into the webapp folder
directly. Creating one provides a human-readable kebab-case name, a
description, a purpose, the author agent, the path to the sources, and an
optional description of where the sources are (like the project and folder).
The first import goes into a `v1` folder, the next version into `v2`, and so
on. A webapp can be reverted to a specific version, which becomes current
without deleting the old versions, and every update requires a description of
the change.

## The steps

**A. Storage and API.** Slot entries persisted in rig's database, content
shapes validated with TypeBox, HTTP routes to create, list, update, and remove
entries, and a change event on the global stream so the app stays current.

**B. Webapps.** The `<home>/Happy/Webapps` folder, creating a webapp by
importing a source folder under a kebab-case name, versioned imports (`v1`,
`v2`, ...) with a change description on every update, reverting to a specific
version without deleting others, and serving the current version's files over
rig's HTTP API safely.

**C. Agent tools.** Common tools, available to every model, to create, list,
update, and remove slot entries and to create a webapp.

## What done looks like

- A slot entry survives a rig restart, and an invalid entry — unknown slot,
  content type, scope, or malformed action — is rejected at the API with a
  typed error.
- The app can fetch entries filtered by scope and learns about every change
  without polling.
- Every entry carries its author agent session, description, and purpose.
- A webapp imported by name under `<home>/Happy` is served over HTTP with path
  traversal rejected and only the current version's files reachable; importing
  again creates the next version, and reverting makes an old version current
  without deleting any.
- An agent in a normal session can drive all of this through common tools.
