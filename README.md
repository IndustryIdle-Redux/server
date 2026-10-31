# Industry Idle server

Self-hosted server for the game's online features: player trading (P2P order book), leaderboards,
chat, crowdfunding aggregation and the WebRTC streaming signalling relay. It is wire-compatible
with the game client's online protocol (`Socket.ts` and the related REST endpoints).

Single process, one port for HTTP and WebSocket, JSON-file persistence, one runtime dependency (`ws`).

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

Node 20 or newer.

## Configuration

Copy `config.example.json` to `config.json` (optional; environment variables override it). Data lives
in `data/db.json`; exported save dumps are written to `data/saves/`.

| Key | Environment variable | Default | Notes |
|---|---|---|---|
| `port` | `PORT` | `5185` | Shared by HTTP and WebSocket |
| `host` | `HOST` | `127.0.0.1` | Loopback only. Exposing it on a LAN/public network requires changing it explicitly **and** setting `ADMIN_TOKEN` |
| `dataDir` | `DATA_DIR` | `data` | Directory for `db.json` and `saves/` |
| `saveFileKey` | `SAVE_FILE_KEY` | empty | Must match the game client's `SAVE_FILE_KEY`; both default to empty |
| `mods` | `MODS` | `[]` | Administrator userIds; `["*"]` makes everyone an administrator (dangerous, warned at startup) |
| `adminToken` | `ADMIN_TOKEN` | empty | Shared secret for the admin endpoints; when set, `/trade/remove` and `/chat/mute` require `X-Admin-Token` |
| `chatRateLimitMs` | | `3000` | Minimum interval between chat messages per user |
| `chatHistorySize` | | `200` | Chat history entries kept per channel |
| `staleTradeTtlMs` | | `0` (off) | Sweep open orders older than this; see the caveat below |
| `maxExportBytes` | `MAX_EXPORT_BYTES` | `8388608` (8 MiB) | Maximum size of a WS `export` save dump; `0` = unlimited |
| `trustAll` | | `true` | Treat new users as authenticated (self-hosted mode has no platform authentication) |

On startup the server prints the effective host, moderators, admin token state, export cap and
sweep TTL, and warns about risky settings.

## Identity, signatures and tokens

- **Users** are identified by the client-supplied `?user=<userId>` handshake parameter and the REST
  `X-User-Id` header. There is no platform-level proof: anyone can claim any userId. In self-hosted
  mode this is a deliberate trade-off, so the `mods` list only prevents casual meddling; use
  `ADMIN_TOKEN` when you need a real credential.
- **tradeToken** is generated client side and binds to a user the first time the server sees it
  (`store.adoptToken`). A token already held by another user cannot be claimed. Rebinding a user to
  a new token does not revoke the old one (so knowing a userId cannot lock the real player out);
  only the proof-carrying routes (`/trade/force-restore`, `/trade/import-save`) revoke it.
- **Trade signatures** are `murmurhash3(sorted JSON values + SAVE_FILE_KEY, floor(now / 5000))`,
  computed by the client (`signTrade`) and re-computed by the server; one window of clock drift is
  accepted either way. The key lives in the client bundle, so a valid signature proves "has the
  client", not "is this user".

## Admin endpoints

The two admin routes are `POST /trade/remove?id=` (delete an order) and `POST /chat/mute?ip=&time=`
(mute in milliseconds, 0 = unmute).

- With `ADMIN_TOKEN` configured: `X-Admin-Token` must match (constant-time compare), or the caller's
  userId must be in `mods` (compatibility; the header is spoofable, so keep `mods` empty when the
  server is reachable by untrusted clients).
- Without `ADMIN_TOKEN`: loopback callers keep the legacy permissive behaviour, non-loopback callers
  get 403.
- Loopback is decided from the socket's real remote address, never from `X-Forwarded-For`.

To expose the server: set `host` to `0.0.0.0` (or `::`), set `ADMIN_TOKEN`, keep `mods` empty, and put
a reverse proxy in front that overwrites `X-Forwarded-For` and limits request sizes and rates.

## WebSocket protocol

Client to server: `join {channel, streaming}`, `chat {user, dlc, flag, message, channel}`, `trade`
(signed order message), `tick` (leaderboard snapshot), `pledge`, `export {data}`, `signal`.

Server to client: `join {messages}`, `chat`, `trade {flush|add|delete|myTrades|error|id}`, `pledge`,
`streaming {users}`, `signal`, `tradeFine` (this server never issues fines).

Every server message carries `time` (for the client's server clock) and `isMod`. The client
force-reconnects after about 70 seconds of silence, so a `tick` gets a state push back.

### Save export

`export` is a debug channel: the client sends its whole save when the server broadcasts an `export`
message. Payloads above `maxExportBytes` are rejected and not written to disk. The userId in the file
name is sanitized, so it cannot escape `saves/`. Writes are synchronous; keep this endpoint for
trusted clients.

### Trade order lifecycle

| Status | Meaning | Server action |
|---|---|---|
| `open` | Order placed (escrow is held by the client) | Added to the book, `add` broadcast, `myTrades` reply |
| `filled` | Someone takes the order | Marked filled, `delete` broadcast, maker gets updated `myTrades` |
| `closed` | Maker collects the proceeds | Moved to history |
| `cancelled` | Maker cancels | `delete` broadcast, moved to history |

The server keeps the original open-order amount as the filled amount, because that is what the taker
paid and what the maker collects.

### Stale order sweeping

With `staleTradeTtlMs > 0`, open orders older than the TTL (measured by server receive time) are
cancelled, moved to history and broadcast as deleted. The client only refunds escrow when it cancels
an order itself, so enabling this leaves the escrowed resources of swept orders held by the trade
center. That is why the default is `0`.

## REST endpoints

| Method | Path | Notes |
|---|---|---|
| GET | `/leaderboard/v4?name=<board>` | `{data, updatedAt}`; row shapes depend on the board |
| GET | `/trade/history` | My order history (`X-User-Id`) |
| POST | `/trade/clear` | Cancel every live order of a user |
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
5. Chat is muted by ip and rate-limited per user; `ip` prefers `X-Forwarded-For`, which is not
   trustworthy behind a proxy. REST admin auth is unaffected by it.
6. Leaderboard definitions ("valuation per hour" etc.) are defined by this implementation.
7. Self-hosting-only options: `staleTradeTtlMs`, `maxExportBytes`, loopback `host` default and an
   empty `mods` default.

## Security notes

This is a small self-hosted server meant for a trusted player base or a private group. It has no
platform authentication, it accepts client-reported identity, and it does not validate the volume or
frequency of most messages. Run it on loopback or behind a proxy that enforces rate and size limits,
keep `mods` empty, set `ADMIN_TOKEN`, and do not expose the admin endpoints to untrusted clients.

## License

GPL-3.0, inherited from the Industry Idle project this server is derived from.
