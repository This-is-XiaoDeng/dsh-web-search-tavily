# dsh-web-search-tavily

[中文](README.zh.md) | English

[![npm](https://img.shields.io/npm/v/@sunaookaminya/dsh-web-search-tavily)](https://www.npmjs.com/package/@sunaookaminya/dsh-web-search-tavily)
[![license](https://img.shields.io/npm/l/@sunaookaminya/dsh-web-search-tavily)](LICENSE)

Tavily-backed search provider for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) web capability seam (`ctx.web`). It makes the built-in `web_search` tool run on [Tavily](https://tavily.com)'s Search API instead of the shipped DeepSeek route.

- **One provider, id `tavily`** — select it with `web.searchProvider`; appears by name in *Settings → Web search and fetch*.
- **Keyed API, per-search resolution** — the key is read from the credential store on every search, so rotating `TAVILY_API_KEY` takes effect on the next request with no restart.
- **Zero dependencies** — Node builtins only (`fetch`, `AbortSignal`); no browser, no auxiliary model request, no extra tokens.
- **Seam-shaped results** — Tavily `results[]` become `{ url, title, snippet }` sources; an optional provider `answer` becomes the result `content`.

## Requirements

- DSH host (`ctx.web` seam), Node.js ≥ 18
- A Tavily API key (`tvly-…`), free tier is 1,000 credits/month; one basic search costs 1 credit, advanced 2

## Install

From npm into a DSH profile (replace `web` with your profile name):

```sh
dsh plugin --profile web add @sunaookaminya/dsh-web-search-tavily
```

Or from a local checkout:

```sh
dsh plugin --profile web add link:/path/to/dsh-web-search-tavily
```

Then add it to the profile's bundle list in `$DSH_HOME/profiles/web/package.json`:

```json
{
  "dsh": { "profile": { "bundles": [ "...", "@sunaookaminya/dsh-web-search-tavily" ] } }
}
```

The bundle patch selects the provider and mounts the row. If you would rather not
add a bundle layer, mount it from the profile's own `cordis.patch.yml` instead —
with `patchReload: live` that hot-mounts without a restart:

```yaml
- id: web
  config:
    searchProvider: tavily
    fetchProvider: http
- insert:
    - id: web-search-tavily
      name: '@sunaookaminya/dsh-web-search-tavily'
      config:
        apiKeyEnv: TAVILY_API_KEY
```

A `web` patch replaces the row's whole config, so carry over every key the
existing row sets (the shipped profile owns `searchProvider` and
`fetchProvider`).

### API key

Store it once in the credential store — the same file the settings UI writes,
which is watched and reloaded automatically:

```yaml
# $DSH_HOME/.credentials.yaml
refs:
  TAVILY_API_KEY: "tvly-…"
```

The launch environment and the `.env` files are fallbacks when no stored value
exists. Never put the key in `cordis.patch.yml`.

## Configuration

Row config keys, all optional:

| Key | Default | Meaning |
| --- | --- | --- |
| `apiKeyEnv` | `TAVILY_API_KEY` | Credential ref resolved per search. |
| `apiKey` | — | Literal key; discouraged, prefer the credential store. |
| `baseURL` | `https://api.tavily.com` | Endpoint; a custom one needs `allowCustomBaseURL: true` and must be https. |
| `allowCustomBaseURL` | `false` | Permits a non-official endpoint. |
| `searchDepth` | `basic` | `basic`, `advanced`, `fast`, `ultra-fast`. |
| `maxResults` | `5` | Default result count when the request sets none (1–20). |
| `includeAnswer` | `false` | Ask Tavily for a generated answer (returned as result `content`). |
| `chunksPerSource` | `3` | Excerpt chunks per source, advanced search only (1–3). |
| `timeoutMs` | `20000` | Per-attempt hard timeout. Keep `attempts × timeoutMs` under `tool-web`'s `searchTimeoutMs` (60s). |
| `attempts` | `2` | Attempts per search (1–4). Only connection failures and HTTP 502/503/504 are retried, with a short backoff — useful on a flaky network. |

## Verify

```sh
cd dsh-web-search-tavily
TAVILY_API_KEY=tvly-… node verify.mjs "some query"
```

It registers on a stub `ctx.web` and runs one real search, printing the sources.

## Switching back

Change `web.searchProvider` back to whatever you want to use (for the shipped
DeepSeek Search API it is `deepseek-search-api`, or `deepseek-official` for
server-side search). The provider rows stay mounted; only the selection changes.

## License

[MIT](LICENSE)
