# Titles — learnings

## First-message naming is part of message admission

Constructing the titles module is not enough: the public send boundary must ask it for the chat and
workspace names before admitting the first real turn, then persist the returned chat title. The
attempt is claimed durably per chat after proving history and the pending queue are empty, so
concurrent sends cannot both rename a workspace and an old untitled conversation is not named from
a later message.

## Placeholder names must remain distinguishable from chosen names

Clients sometimes create a workspace with a temporary display name before its first chat exists.
Workspace creation therefore carries whether the supplied name was deliberately chosen. Omission
means chosen for compatibility; an explicit false keeps the workspace eligible for first-message
naming. Names supplied by the workspace-creation agent tool are deliberate.
