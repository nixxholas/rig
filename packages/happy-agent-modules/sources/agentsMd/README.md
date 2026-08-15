# AGENTS.md module

`AgentsMdModule` receives the shared compute resolver. For each hook or tool call it asks for that
agent's cached compute, then discovers the `AGENTS.md` files that apply to its working directory.
It walks from the nearest Git root down to `compute.cwd`, reads each document through
`compute.fs`, and supplies the result only through the system-prompt instruction hook. It exposes
no tools.

Discovery is live, bounded, refuses a symbolic link at the document itself, and owns no database
or persistent state.