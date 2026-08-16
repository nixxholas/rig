# Search

Web search and page fetch, over a backend the host supplies. The module does not talk to any
search engine or the network itself; it validates and bounds what goes out to the backend and what
comes back from it. Every model receives the same fixed ordinary-tool array. The vendor names
select a host route; they do not lift a provider's server tool into Agent Base.

```ts
import { Agent } from "@slopus/happy-agent-base";
import { SearchModule } from "@slopus/happy-agent-modules";

const search = new SearchModule({
    backend: hostSearchBackend,
    maxResults: 10,
    maxCharacters: 40_000,
    maxOutputCharacters: 12_000,
});
const agent = await Agent.create(ctx, { ...options, modules: [search] });
```

`backend` is the only required option; it must satisfy `SearchBackend` (below). `maxResults` caps
results per page (1–50, default 10), `maxCharacters` caps fetched content before truncation
(1,000–100,000, default 40,000), and `maxOutputCharacters` caps what the model actually sees per
tool call (256–100,000, default 12,000). One `SearchModule` instance can serve every agent in a
collection; `agentId` is threaded through to the backend on each call.

## Tools

The fixed array matches Rig:

- **`web_fetch`**
- **`gemini_web_search`**
- **`claude_web_search`**
- **`codex_web_search`**
- **`bedrock_web_search`**
- **`grok_web_search`**
- **`grok_x_search`**

All seven tools are available to Claude, Codex, Grok, Bedrock, and future providers. Search calls
use `SearchBackend.searchProvider` when the host implements it, passing the selected vendor,
optional provider ID, and the vendor-specific domain/latest filters. A backend that predates routed
search can still serve the calls through its generic `search` function.

Each search returns a bounded `SearchPage`. The model sees one URL per line, opportunistically
followed by ` — title` when it fits, plus `next_cursor=<n>` when another page exists.

- **`web_fetch`** — fetches one URL through the backend with `{ url, maxCharacters? }` and returns
  a `FetchResult`. `url` must be a valid `http`/`https` URL (max 200 characters after
  normalization); anything else is rejected before the backend is called. `maxCharacters`
  (1,000–100,000) is clamped to the module's `maxCharacters`. The model sees the URL first, then
  the title and content as far as they fit `maxOutputCharacters`, with a `[Content truncated.]`
  marker when the model-visible text or the underlying content was cut.

All tools are `durable: false` because retrying an interrupted backend call could repeat billed or
externally observable work. They require Auto or Full access and request Auto review because the
host performs network work outside the local shell sandbox. The module itself does not touch the
filesystem or a compute; everything goes through the injected backend. The URL is always the
identity that is kept intact: formatting never
truncates or drops a URL to make room for a title, snippet, or continuation cursor, so every row
the model is shown remains one it can act on or follow.

## External functions

- **`search.search(ctx, agentId, query: SearchQuery): Promise<SearchPage>`** — normalizes and
  bounds `query`, calls `backend.search(ctx, agentId, normalized)`, and validates the returned page
  before returning it. Validation requires the page to echo the same (trimmed) `query`, to return
  no more results than requested, to use canonical `http`/`https` URLs with no duplicate URLs or
  ids, and — when `nextCursor` is present — to advance the cursor by exactly the number of visible
  results (`requested + results.length`), never past a page that returned nothing. It also confirms
  the whole page can be rendered for the model within the format's rules before returning, so a
  page whose identities cannot all be shown is rejected outright rather than silently trimmed.
- **`search.fetch(ctx, agentId, input: FetchInput): Promise<FetchResult>`** — normalizes and
  lower-bounds `input.url` (protocol, canonical form, length), calls
  `backend.fetch(ctx, agentId, normalized)`, and requires the backend to return content for that
  same normalized URL. If the backend's content exceeds the requested character bound, it is
  sliced and `truncated` is forced to `true`.
- **`search.formatSearchForModel(page: SearchPage): string`** and
  **`search.formatFetchForModel(result: FetchResult): string`** — the exact formatting the tools
  use to turn a validated page or fetch result into model-visible text, exposed so a host can
  render the same output outside a tool call. Both throw if given a page or result that fails the
  corresponding schema.
- **`search.providerSearch(ctx, agentId, request)`** — normalizes a vendor-routed request and uses
  the routed host boundary, while preserving the same page and output bounds as `search`.
- **`search.tools(ctx, scope)`** — returns the fixed seven-tool array above for every provider.

None of these functions emit events or take listeners; the module has no async or background work
of its own; every call resolves or rejects within the single `search`/`fetch` round trip.

## Storage

The module persists nothing itself. It is stateless between calls: `SearchModule` holds only its
constructor-time bounds (`maxResults`, `maxCharacters`, `maxOutputCharacters`) and a reference to
the host-supplied `backend`, and every `search`/`fetch` call is answered fresh from that backend.
Any durability — caching search results, storing fetched pages, rate-limiting a client, keeping
indexes — is entirely the concern of the host's `SearchBackend` implementation, which the module
never inspects beyond its `search` and `fetch` function shapes (`searchBackendSchema` in
`SearchBackend.ts`). Cursors are likewise not stored: a cursor is just the offset the backend
already returned, and the model must submit it back verbatim to page forward.
