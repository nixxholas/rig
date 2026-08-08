# Master plan 18: folders and documents

How to implement this is not yet clear. What follows is the idea.

## Big picture

Instead of focusing on projects and worktrees, we have a more controlled
filesystem of files, documents and so on.

Every folder has one main chat, optionally, and several optional additional
chats. Think of it as Notion, except it is built around chats rather than
around documents. Documents are what the chat produces.

When we open a folder in Happy we see the main chat and the additional ones,
and maybe some applets or something like that.

This lives in parallel with what we have today. Code projects and Git
workspaces stay as they are; folders are a new way of working — media,
documents, work that is not code.

Projects — actual projects — can be elements of this tree. They are also like
folders, but rather they are terminal folders.

Every folder has some description and some rules. Every folder potentially has
an icon: a picture, an emoji, or one of some predefined icons.

## Unsorted

It must be possible to create a new chat that at first has no folder — it is
not defined where it is. Then, as you talk to it, it can put itself into one of
the folders. The model does this by itself. Or it happens by drag-and-drop.

Until then such chats sit in an Unsorted list at the very top, above the main
folders. They are archived automatically within 24 hours if they have not
sorted themselves, or if sorting is impossible.

## The tree

The most interesting part is that this is a tree of folders. We must be able to
manipulate it very easily: we must be able to drag and drop folders freely.

These folders are not really filesystem folders. They are not nested inside one
another; they are only virtually nested. An agent knows which folder it is in
both virtually and physically, and those are two different things.

Physically the storage is flat: every folder is its own flat directory under an
opaque id. Nesting exists only in the tree. Moving a folder rearranges the tree
and changes the folder's parameters; it does not move anything on disk.

Because we can move folders around and change their parameters, the tree is a
dynamic thing, while on the filesystem it stays static.

## Checkpointing

The most interesting feature we need is being able to track what changed —
something like checkpointing. When the model has done something, it should be
able to save everything automatically, or roll it back. It feels like this
belongs at the filesystem level.

We do not know yet how to do it. Three directions, none of them chosen:

- Something like a virtual filesystem, but not a real filesystem, restricting
  what can be done with files at all. In Node.js you can present a virtual
  filesystem to processes, and our agents are still assumed to run in a single
  Node.js process, so we could synchronize all of it somehow cleverly.
- Not the Mac's filesystem at all: always run in containers and snapshot the
  containers.
- Copy-on-write snapshots at the filesystem level.

What the plan fixes is the requirement, not the mechanism.

Assume there will be very many very large files, constantly changing. Say
someone does media production on this — it is easy to imagine a folder holding
a project where they make videos. It is also multi-user, so all of it can take
a very, very large amount of disk space. So we must be able to point, fork and
roll back very efficiently, Time-Machine-like.

## The steps

**A. Folders and chats.** The tree, the main chat and the additional chats in
each folder, each folder's description, rules and icon, and flat physical
storage under opaque ids. Done when a folder can be created in Happy, its main
chat opened, and its documents produced by that chat.

**B. Manipulating the tree.** Free drag-and-drop of folders, and folder
parameters that can change, while nothing moves on disk. Done when rearranging
the tree is instant and an agent still knows both where it is virtually and
where it is physically.

**C. Unsorted chats.** A new chat with no folder, the Unsorted list above the
folders, a chat that files itself while you talk to it, and automatic archiving
after 24 hours. Done when a chat started from nowhere ends up in the right
folder on its own, and one that cannot is gone the next day.

**D. Checkpointing.** Pick one of the three directions and track what changed,
so a model's work is saved automatically or rolled back. Done when a folder can
be pointed at, forked and rolled back cheaply with very large files in it.

## What done looks like

- Work is organized as a tree of folders holding files and documents, alongside
  code projects rather than replacing them.
- A project sits in that tree as a terminal folder.
- A folder is a chat, optionally several, and the documents those chats produce,
  with its own description, rules and icon.
- A chat can start belonging nowhere, file itself into a folder while you talk
  to it, and disappear on its own if it never does.
- The tree is virtual and dynamic; the storage under it is flat and static.
- An agent knows its virtual folder and its physical folder, and the two are
  not the same thing.
- Everything a model does is saved or rolled back on its own.
- Pointing, forking and rolling back stay cheap when the folders are full of
  very large files and many people are using them.
