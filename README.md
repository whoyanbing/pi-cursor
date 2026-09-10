# pi-cursor

A [pi](https://shittycodingagent.ai/) provider extension that connects pi to **Cursor** models
(Claude, GPT, Gemini, Grok, Composer…) through Cursor's native agent protocol.

This is an independent, clean-room implementation of the Cursor wire protocol — not a repackaging
of any existing package. It registers the `cursor` provider with the `cursor-native` API.

## How it works

Cursor does not expose a REST/SSE API. It speaks **Connect RPC (protobuf) over HTTP/2**:

```text
pi (streamSimple)
    ↓
src/protocol/stream.ts   — turn orchestration, tool-call bridging
    ↓
src/transport/h2.ts      — persistent in-process node:http2 session
    ↓
https://agentn.us.api5.cursor.sh  /agent.v1.AgentService/Run
```

Key design decisions:

- **Prompt history is explicit.** Cursor renders the model prompt from
  `root_prompt_messages_json` (blob ids of AI-SDK-shaped JSON messages), not from `turns`.
  This extension rebuilds that history from Pi's context on every turn — the system prompt
  rides a `<rules>`-framed user message, and completed turns replay as
  user / assistant(tool-call) / tool(tool-result) messages.
  After Pi compaction the conversation id rotates (first-prompt fingerprint) so Cursor
  does not keep the pre-compact transcript; otherwise context stays at ~94% and compact
  loops. Threshold compact is also skipped on the Cursor provider until usage actually
  drops. Oversized blobs throw instead of sending a dangling id.
- **Live bridge for tool calls.** When the model invokes an MCP tool mid-turn, the Run stream
  is *parked* (not closed) while Pi executes the tool. The next call answers the pending exec
  inline on the same stream and the turn continues — no conversation rebuild, no synthetic
  messages. If the bridge died (network, restart, pause timeout), the next call transparently
  rebuilds full history and continues with a synthetic `Continue.` turn.
- **Content-addressed blobs.** System prompt, history messages and turn structures are stored
  by SHA-256; the server pulls them over the KV channel during the run.
- **Native Cursor tools are rejected with guidance.** When the server asks the client to run
  `read`/`grep`/`shell`/…, the exec is rejected with a message naming the equivalent Pi MCP
  tool, so the model retries through Pi's real tools.

## Install

```bash
cd ~/.pi/agent/extensions/pi-cursor
npm install
```

Then restart pi (or `/reload`).

If you previously used the npm `@rahularya01/pi-cursor` package, remove it so the two do not
both register the `cursor` provider:

```text
pi remove npm:@rahularya01/pi-cursor
```

## Login

```text
/login cursor
```

Opens `cursor.com/loginDeepControl` (PKCE); approve in the browser and the extension polls
`api2.cursor.sh/auth/poll` until tokens arrive. Refresh is automatic
(`exchange_user_api_key`, with a 5-minute expiry skew).

Credential cascade (first match wins):

1. `CURSOR_ACCESS_TOKEN` env var
2. Pi's OAuth store (`~/.pi/agent/auth.json`, written by `/login cursor`)
3. macOS Keychain (tokens saved by the Cursor CLI: `cursor-access-token` / `cursor-refresh-token`)
4. Cursor IDE local state (`globalStorage/state.vscdb`)

Steps 3–4 reuse desktop-app credentials. The first session that picks them up
shows a one-time notice; disable reuse with `PI_CURSOR_SYSTEM_CREDENTIALS=0`.

## Commands

```text
/cursor.model [filter|all]   List registered models (ctx windows, thinking levels, images).
                             Helpers (tab_/chat_) are hidden unless `all` is passed.
/cursor.usage                Plan usage for the current billing period: included spend vs
                             limit, auto/API percentages, remaining, on-demand spend,
                             Pro/Team membership, reset date.
/cursor.doctor               Sanitized diagnostics: agent URL, client version, token source,
                             model cache age, active bridges, last RPC/error, hints.
```

## Models

At startup the bundled catalog (`src/models/catalog.json`) is registered synchronously, so
`/model` works offline. After login, discovery refreshes it:

- `AgentService/GetUsableModels` — the account's authoritative model rows
- `AiService/AvailableModels` — parameterized metadata (image support, context limits,
  per-variant request parameters / max-mode), merged by variant representation

Effort variants (`gpt-5-high`, `gpt-5-xhigh`, …) collapse into one Pi model whose
thinking-level map points at the raw ids; `options.reasoning` selects the variant at request
time. Results cache to `~/.pi/agent/cursor-models-cache.json` (6h TTL).

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `CURSOR_ACCESS_TOKEN` | — | Bypass login with a raw access token |
| `PI_CURSOR_AGENT_URL` / `CURSOR_AGENT_URL` | `https://agentn.us.api5.cursor.sh` | Override the agent endpoint (CLI config cache is consulted first otherwise) |
| `PI_CURSOR_CLIENT_VERSION` | probed from `cursor-agent --version` (fallback `cli-2026.08.25-3e8eec8`) | `x-cursor-client-version` header |
| `PI_CURSOR_SYSTEM_CREDENTIALS` | allowed | Set `0` to skip Keychain/IDE credential reuse. First use otherwise notifies once. |
| `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS` | `180000` | Silence watchdog; `0` disables |
| `PI_CURSOR_CONNECT_TIMEOUT_MS` | `30000` | HTTP/2 handshake timeout; `0` disables. Timed-out runs retry once on a fresh session |
| `PI_CURSOR_BRIDGE_PAUSE_MS` | `900000` | Max time a parked bridge waits for tool results |
| `PI_CURSOR_HEARTBEAT_MS` | `15000` | Client heartbeat cadence on the Run stream |

## Development

```bash
npm run check    # tsc --noEmit
npm test         # vitest (offline: fake transports + fixtures, plus a local h2 pool test)
npm run proto:gen  # regenerate src/proto/agent_pb.ts from proto/agent.proto (buf)
```

Architecture:

```text
src/
  index.ts            extension entry (api + provider + commands)
  config.ts           endpoints, env tunables, client identity
  diagnostics.ts      last-run state for /cursor.doctor
  auth/               oauth (PKCE), credential cascade, usage
  transport/          connect framing, persistent http2 session
  protocol/           context parsing, prompt history, blobs, tools,
                      request build, server dispatch, bridge, stream
  models/             wire codec, discovery, processing, registry, catalog
  proto/agent_pb.ts   generated from proto/agent.proto (@bufbuild/protoc-gen-es)
```

## Credits

The wire protocol was reverse-engineered by the community; this implementation follows the
same public protocol description (Connect RPC v1, `agent.v1` schema) and MIT-licensed prior
art, including [@rahularya01/pi-cursor](https://github.com/Rahularya01/pi-cursor) and
[@pi-stef/cursor](https://www.npmjs.com/package/@pi-stef/cursor). `proto/agent.proto` and the
seed `catalog.json` are taken from the reference project (MIT); everything else is an
independent implementation.

## License

MIT
