# Master plan 6: Inbox

## Big picture

Inbox is the place where agents can write something to the human: ask them a
question, or ask them to fill in some form. All of it lands in one durable
Inbox that is available to the human, and from a simple interface they can
answer without entering the specific chat.

The feature is automatically enabled in every agent, and an instruction is
added telling the agent that it can write to the Inbox.

## One shared state

When the model asks a question — AskUserQuestion for Claude,
`request_user_input` for Codex, `ask_user_question` for Grok — the question is
shown in the chat and in the Inbox at the same time. No matter where it is
answered, it is closed everywhere: it is one single shared state, not two
copies.

So if the human is sitting in the terminal and is asked "do it this way or
that way", and they answer right there, the entry still appears in the Inbox —
first as a question, then as answered.

## Ordering in the Inbox

The user must be able to reorder the requests — in the Inbox interface
specifically. Reordering works like fractional indexing and all that, so a
person can simply take their tasks and put them in order.

Completed answers are different: they are sorted exclusively by date, nothing
else.

## Questions are durable

The AskUserQuestion tool itself must become more durable: it must survive
restarting the daemon and so on, because a question can hang for a very long
time — days, weeks, indefinitely.

## Questions carry their context

The nuance: these ask tools must be reworked, and the prompt must be changed so
that the question includes all the context the human needs to see if they are
not in that chat. It is not an abstract question. It is a wide, rich document —
essentially a Markdown file — that gives the human what they need to make the
decision.
