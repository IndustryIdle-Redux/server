# Industry Idle server

Self-hosted server for the game's online features: player trading (P2P order book), leaderboards,
chat, crowdfunding aggregation and the WebRTC streaming signalling relay. It is wire-compatible
with the game client's online protocol (`Socket.ts` and the related REST endpoints).

Single process, one port for HTTP and WebSocket, SQLite persistence (`node:sqlite`, WAL), one runtime dependency (`ws`).

## Quick start

```bash
npm install
npm start          # builds and runs; listens on http://127.0.0.1:5185 by default
```

Then in the game open **Settings -> General -> Game Server**, enter `localhost:5185` and apply. The
address is a persisted setting, not a URL parameter: a URL parameter could be used by a link to
silently route a player's trades and chat to another host. Leaving the field empty goes back to the
official server.

```bash
npm test           # unit + integration + security tests
npm run typecheck
npm run build      # bundles dist/server.js only
```

Node 24 or newer (for an unflagged `node:sqlite`).

## Persistence

The database lives in `data/db.sqlite` (SQLite with WAL). The server keeps the working set in memory
and writes only the rows changed by a mutation, batched in one transaction every 500 ms; there is
no full-database rewrite. To back up a running server, copy `db.sqlite` together with its `-wal`
file, or use SQLite's backup / `VACUUM INTO` while the server is stopped.

## Configuration

Copy `config.example.json` to `config.json` (optional; environment variables override it). Data lives
in `data/db.sqlite`; exported save dumps are written to `data/saves/`.

| Key | Environment variable | Default | Notes |
|---|---|---|---|
| `port` | `PORT` | `5185` | Shared by HTTP and WebSocket |
| `host` | `HOST` | `127.0.0.1` | Loopback only. Exposing it on a LAN/public network requires changing it explicitly **and** setting `ADMIN_TOKEN` |
| `dataDir` | `DATA_DIR` | `data` | Directory for `db.sqlite` and `saves/` |
| `saveFileKey` | `SAVE_FILE_KEY` | empty | Must match the game client's `SAVE_FILE_KEY`; both default to empty |
| `mods` | `MODS` | `[]` | Moderator userIds (in-game mod flag, and admin routes when no `ADMIN_TOKEN` is set); `["*"]` makes everyone a moderator (dangerous, warned at startup) |
| `adminToken` | `ADMIN_TOKEN` | empty | Shared secret for the admin endpoints; when set, `/trade/remove` and `/chat/mute` require `X-Admin-Token` |
| `chatRateLimitMs` | | `3000` | Minimum interval between chat messages per user |
| `chatHistorySize` | | `200` | Chat history entries kept per channel |
| `staleTradeTtlMs` | | `0` (off) | Sweep open orders older than this; see the caveat below |
| `maxExportBytes` | `MAX_EXPORT_BYTES` | `8388608` (8 MiB) | Maximum size of a WS `export` save dump; `0` = unlimited |
| `maxWsPayloadBytes` | `MAX_WS_PAYLOAD_BYTES` | `10485760` (10 MiB) | Maximum size of one WebSocket message; must stay above `maxExportBytes` for exports to work |
| `wsRateLimitPerSecond` | `WS_RATE_LIMIT_PER_SECOND` | `50` | Per-connection message budget per second; `0` disables the limit |
| `exportMinIntervalMs` | `EXPORT_MIN_INTERVAL_MS` | `10000` | Minimum interval between `export` uploads per user; `0` disables the quota |
| `leaderboardCacheMs` | `LEADERBOARD_CACHE_MS` | `1000` | Response cache TTL for `/leaderboard/v4`; `0` disables the cache |
| `requireTradeTokenProof` | `REQUIRE_TRADE_TOKEN_PROOF` | `false` | Require `X-Trade-Token` for `/trade/clear` and `/trade/history`; enable once your client sends it |
| `maxUsers` | `MAX_USERS` | `10000` | Maximum user records; new connections above the cap are refused (4004); `0` = unlimited |
| `maxChatChannels` | `MAX_CHAT_CHANNELS` | `100` | Maximum chat channels kept; `0` = unlimited |
| `snapshotRetentionMs` | `SNAPSHOT_RETENTION_MS` | 90 days | Leaderboard snapshots not updated for this long are pruned on the heartbeat; `0` = keep forever |
| `trustForwardedFor` | `TRUST_FORWARDED_FOR` | `false` | Use `X-Forwarded-For` as the client ip. Only enable behind a reverse proxy that overwrites it |
| `trustAll` | | `true` | Treat new users as authenticated (self-hosted mode has no platform authentication) |

On startup the server prints the effective host, moderators, admin token state, export cap and
sweep TTL, and warns about risky settings.

## Identity, signatures and tokens

- **Users** are identified by the client-supplied `?user=<userId>` handshake parameter and the REST
  `X-User-Id` header. There is no platform-level proof: anyone can claim any userId. In self-hosted
  mode this is a deliberate trade-off, so the `mods` list only prevents casual meddling; use
  `ADMIN_TOKEN` when you need a real credential.
- **tradeToken** is generated client side and binds to a user only after a trade message verified
  its signature (`store.adoptToken`). A token already held by another user cannot be claimed.
  Rebinding a user to a new token does not revoke the old one (so knowing a userId cannot lock the
  real player out); only the proof-carrying routes (`/trade/force-restore`, `/trade/import-save`)
  revoke it. The optional `requireTradeTokenProof` setting also demands `X-Trade-Token` for
  `/trade/clear` and `/trade/history`.
- **Trade signatures** are `murmurhash3(sorted JSON values + SAVE_FILE_KEY, floor(now / 5000))`,
  computed by the client (`signTrade`) and re-computed by the server; one window of clock drift is
  accepted either way. The key lives in the client bundle, so a valid signature proves "has the
  client", not "is this user".

## Admin endpoints

The two admin routes are `POST /trade/remove?id=` (delete an order) and `POST /chat/mute?ip=&time=`
(mute in milliseconds, 0 = unmute).

- With `ADMIN_TOKEN` configured: `X-Admin-Token` must match (constant-time compare). The `mods` list
  does **not** grant admin access in this mode, because it is keyed on the spoofable `X-User-Id`
  header. It only controls the in-game moderator flag.
- Without `ADMIN_TOKEN`: loopback callers keep the legacy permissive behaviour, non-loopback
  configured moderators may still administer (the spoofable header is the identity). Set the token
  when the server is reachable by untrusted clients.
- Loopback is decided from the socket's real remote address, never from `X-Forwarded-For`.

To expose the server: set `host` to `0.0.0.0` (or `::`), set `ADMIN_TOKEN`, keep `mods` empty, and put
a reverse proxy in front that overwrites `X-Forwarded-For` and limits request sizes and rates. Set
`TRUST_FORWARDED_FOR=1` only if that proxy overwrites the header; otherwise the server uses the socket
address and ignores it.

## WebSocket protocol

Client to server: `join {channel, streaming}`, `chat {user, dlc, flag, message, channel}`, `trade`
(signed order message), `tick` (leaderboard snapshot), `pledge`, `export {data}`, `signal`.

Messages are bounded: one frame may be at most `maxWsPayloadBytes`, each connection gets a
`wsRateLimitPerSecond` token budget, chat channels/names/flags and other persisted strings are
length-capped, pledge entries and WebRTC sessions are bounded, and oversized `export` dumps are
rejected. A connection that exceeds the message rate is closed with code 1008.

Server to client: `join {messages}`, `chat`, `trade {flush|add|delete|myTrades|error|id}`, `pledge`,
`streaming {users}`, `signal`, `tradeFine` (this server never issues fines).

Every server message carries `time` (for the client's server clock) and `isMod`. The client
force-reconnects after about 70 seconds of silence, so a `tick` gets a state push back.

### Save export

`export` is a debug channel: the client sends its whole save when the server broadcasts an `export`
message. Payloads above `maxExportBytes` are rejected and not written to disk. The userId in the file
name is sanitized, so it cannot escape `saves/`; a timestamp and random suffix keep rapid uploads from
overwriting each other, uploads are rate-limited per user (`exportMinIntervalMs`) and written
asynchronously so a large dump cannot block other connections.

### Trade order lifecycle

| Status | Meaning | Server action |
|---|---|---|
| `open` | Order placed (escrow is held by the client) | Added to the book, `add` broadcast, `myTrades` reply |
| `filled` | A player takes all or part of an open order | Creates a **separate filled record** for the maker, reduces the open order, broadcasts `add` (remaining) or `delete` (exhausted), updates the maker's `myTrades` |
| `closed` | Maker claims one filled record | That fill is moved to history and removed from `myTrades` |
| `cancelled` | Maker cancels the open remainder | `delete` broadcast, remainder moved to history |

Partial fills are supported: one order can be filled by several players in sequence. Each fill is
recorded as its own claim in the maker's `myTrades`, keyed by a server-generated id, because the
client's `claimTrade` works on one id at a time. The open order keeps the remaining amount until it
is exhausted.

### Stale order sweeping

With `staleTradeTtlMs > 0`, open orders older than the TTL (measured by server receive time) are
cancelled, moved to history and broadcast as deleted. The client only refunds escrow when it cancels
an order itself, so enabling this leaves the escrowed resources of swept orders held by the trade
center. That is why the default is `0`.

## REST endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/leaderboard/v4?name=<board>` | `{data, updatedAt}`; row shapes depend on the board |
| GET | `/trade/history` | My order history (`X-User-Id`; requires `X-Trade-Token` when `requireTradeTokenProof` is set) |
| POST | `/trade/clear` | Cancel every live order of a user (requires `X-Trade-Token` when `requireTradeTokenProof` is set) |
| POST | `/trade/remove?id=` | Admin order deletion |
| POST | `/trade/resolve-fine` | Accepted; this server never issues fines |
| POST | `/trade/import-save?token=` | Bind/rotate a trade token; requires token proof |
| POST | `/trade/force-restore?token=` | Restore trade rights; requires the current token |
| POST | `/user/authentication` | Pass-through in self-hosted mode |
| POST | `/user/verification?tradeToken=` | `VerificationResult`; binds the token on first use |
| POST | `/chat/mute?ip=&time=` | Mute/unmute (admin) |
| POST | `/stream?status=on\|off` | Streaming discoverability list |
| GET | `/health` | Health check |

All responses carry CORS headers (the game runs on another origin); `OPTIONS` preflight returns 204.

## Streaming (WebRTC signalling)

`POST /stream?status=on` adds a streamer to the discoverability list. A viewer sends
`signal {init, token, user}`; the server issues a session key and relays `offer/answer/candidate/...`
between the two sides until `cancelInit`, `reject` or `failed`.

## Differences from the official server

1. No platform authentication: `trustAll` defaults to true and `/user/verification` reports
   `trusted`. This affects only those booleans, not admin/mod rights or token checks.
2. Admin auth is a shared secret / spoofable userId mod list, not an official account system.
3. Trade tokens are proven by the token itself; `/trade/force-restore` and `/trade/import-save`
   accept `X-Trade-Token`.
4. It never issues anti-cheat fines, never force-logs-out and does not call platform checks.
5. Chat is muted by ip and rate-limited per user. The client ip comes from the socket unless
   `trustForwardedFor` is enabled, in which case `X-Forwarded-For` is used and must be set by a
   trusted proxy. REST admin auth never depends on the forwarded header.
6. Leaderboard definitions ("valuation per hour" etc.) are defined by this implementation.
7. Self-hosting-only options: `staleTradeTtlMs`, `maxExportBytes`, `maxWsPayloadBytes`,
   `wsRateLimitPerSecond`, `exportMinIntervalMs`, `maxUsers`, `maxChatChannels`,
   `snapshotRetentionMs`, loopback `host` default and an empty `mods` default.

## Security notes

This is a small self-hosted server meant for a trusted player base or a private group. It has no
platform authentication and it accepts client-reported identity. WebSocket messages are size-capped,
rate-limited per connection and their persisted fields are length-capped; REST stays lightweight
(leaderboard responses are cached) but there is no per-ip HTTP rate limit, so keep a rate-limiting
proxy in front when exposing the server. Run it on loopback or behind such a proxy, keep `mods`
empty, set `ADMIN_TOKEN`, and do not expose the admin endpoints to untrusted clients.

## License

GPL-3.0, inherited from the Industry Idle project this server is derived from.
