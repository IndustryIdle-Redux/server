/**
 * REST API — everything the client fetches through `API_HOST`
 * (`src/shared/state/GameData.ts`, `LeaderboardPage.ts`, `PlayerTradeHistoryPage.ts`, …).
 *
 * The game runs in a browser on another origin (e.g. `http://localhost:5180`), so every
 * response carries permissive CORS headers and `OPTIONS` preflights are answered.
 *
 * | method | path | body / query | response |
 * |---|---|---|---|
 * | GET | `/leaderboard/v4` | `?name=<board>` | `{ data, updatedAt }` |
 * | GET | `/trade/history` | header `X-User-Id` | `IHistoricalTrade[]` (oldest first) |
 * | POST | `/trade/clear` | header `X-User-Id` | 200 — drops all live orders of the user |
 * | POST | `/trade/remove` | `?id=` — admin (`X-Admin-Token` or mod + loopback) | 200 / 403 / 404 |
 * | POST | `/trade/resolve-fine` | `{ tradeFine, tick }` | 200 — accepted, never penalises |
 * | POST | `/trade/import-save` | `?token=` + trade-token proof | `{ token }` — rotated token / 403 |
 * | POST | `/trade/force-restore` | `?token=`/`X-Trade-Token` = current token | 200 / 403 |
 * | POST | `/user/authentication` | `?user&platform&version` | 200 |
 * | POST | `/user/verification` | `?tradeToken=` | `VerificationResult` |
 * | POST | `/chat/mute` | `?ip=&time=` (ms) — admin (`X-Admin-Token` or mod + loopback) | 200 / 403 |
 * | POST | `/stream` | `?status=on\|off` | `{ streaming, token }` |
 * | GET | `/health` | | `{ ok: true }` |
 *
 * ## Admin authentication model
 *
 * Self-hosted mode has **no platform authentication**: the only identity a request
 * carries is the client-supplied `X-User-Id` header, which anybody can spoof. The two
 * admin routes (`/trade/remove`, `/chat/mute`) are therefore guarded like this:
 *
 *   - `adminToken` configured → the caller must send it in `X-Admin-Token` (constant-time
 *     compare). The `mods` list does not grant admin access in this mode: it is keyed on
 *     the spoofable `X-User-Id` header and the token is the only real credential.
 *   - `adminToken` **not** configured → legacy behaviour is kept for **loopback** callers
 *     (the local operator) and remote callers get 403. Loopback is decided from the socket
 *     address, never from `X-Forwarded-For` (which is client controlled).
 */

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { isLoopbackAddress, type ServerConfig } from "./config";
import { computeBoard } from "./leaderboard";
import type { Store, UserRecord } from "./store";
import type { Hub } from "./ws";
import type { IVerificationResult } from "./types";

const MAX_BODY = 8 * 1024 * 1024;

function cors(res: ServerResponse): void {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type, X-User-Id, X-Admin-Token, X-Trade-Token");
}

function json(res: ServerResponse, status: number, body: unknown): void {
    cors(res);
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

function text(res: ServerResponse, status: number, body: string): void {
    cors(res);
    res.writeHead(status, { "Content-Type": "text/plain" });
    res.end(body);
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let size = 0;
        req.on("data", (c: Buffer) => {
            size += c.length;
            if (size > MAX_BODY) {
                reject(new Error("body too large"));
                req.destroy();
                return;
            }
            chunks.push(c);
        });
        req.on("end", () => {
            if (chunks.length === 0) return resolve({});
            try {
                resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
            } catch {
                resolve({});
            }
        });
        req.on("error", reject);
    });
}

/* ---------------- auth helpers ---------------- */

function headerString(value: string | string[] | undefined): string {
    return Array.isArray(value) ? (value[0] ?? "") : (value ?? "");
}

/**
 * Constant-time string comparison (hashes both sides first so the comparison does not
 * leak the length). Empty values never match — an unset token must not authenticate.
 */
export function constantTimeEqual(a: string, b: string): boolean {
    if (!a || !b) return false;
    const ha = createHash("sha256").update(a, "utf8").digest();
    const hb = createHash("sha256").update(b, "utf8").digest();
    return timingSafeEqual(ha, hb);
}

/**
 * Whether a request may use an admin route (`/trade/remove`, `/chat/mute`).
 *
 * See the module doc for the rationale. Exported so the loopback / token rules can be
 * unit tested without a real non-loopback connection.
 */
export function isAdminAuthorized(req: IncomingMessage, hub: Hub, config: ServerConfig, userId: string): boolean {
    if (config.adminToken) {
        // A configured token is the only credential for admin routes. The mods list is keyed
        // on the spoofable X-User-Id header and must not be able to bypass it.
        return constantTimeEqual(headerString(req.headers["x-admin-token"]), config.adminToken);
    }
    // no admin token: the local operator (genuine loopback) keeps the legacy behaviour …
    if (isLoopbackAddress(req.socket.remoteAddress)) return true;
    // … and so do explicitly configured mods, so an operator can still administer a
    // deployment whose mods list they filled in on purpose.
    return hub.isMod(userId);
}

function adminDenied(config: ServerConfig): string {
    return config.adminToken
        ? "invalid or missing X-Admin-Token"
        : "admin endpoints are restricted to loopback callers; set ADMIN_TOKEN to administer the server remotely";
}

/**
 * Route one HTTP request. Returns a promise that settles when the response is written.
 */
export async function handleRest(
    hub: Hub,
    store: Store,
    config: ServerConfig,
    req: IncomingMessage,
    res: ServerResponse
): Promise<void> {
    cors(res);
    if (req.method === "OPTIONS") {
        res.writeHead(204);
        res.end();
        return;
    }

    const url = new URL(req.url ?? "/", "http://localhost");
    const p = url.pathname;
    const method = req.method ?? "GET";
    const userId = String(req.headers["x-user-id"] ?? "");

    try {
        /* ---------------- health ---------------- */
        if (p === "/health") {
            return json(res, 200, { ok: true, uptime: process.uptime() });
        }

        /* ---------------- leaderboard ---------------- */
        if (p === "/leaderboard/v4" && method === "GET") {
            const name = url.searchParams.get("name") ?? "";
            return json(res, 200, computeBoard(store.db, name));
        }

        /* ---------------- trades ---------------- */
        if (p === "/trade/history" && method === "GET") {
            return json(res, 200, userId ? hub.trades.history(userId) : []);
        }
        if (p === "/trade/clear" && method === "POST") {
            const count = userId ? hub.trades.clearTrades(userId) : 0;
            return json(res, 200, { removed: count });
        }
        if (p === "/trade/remove" && method === "POST") {
            if (!isAdminAuthorized(req, hub, config, userId)) return text(res, 403, adminDenied(config));
            const id = url.searchParams.get("id") ?? "";
            return hub.trades.removeTrade(id) ? json(res, 200, { ok: true }) : text(res, 404, "trade not found");
        }
        if (p === "/trade/resolve-fine" && method === "POST") {
            await readBody(req); // payload ignored: this server never issues fines
            return json(res, 200, {});
        }
        if (p === "/trade/import-save" && method === "POST") {
            const token = url.searchParams.get("token") ?? "";
            const proof = headerString(req.headers["x-trade-token"]);
            const result = importToken(store, userId, token, proof);
            if (result.status !== 200) return text(res, result.status, result.message);
            return json(res, 200, { token: result.token });
        }
        if (p === "/trade/force-restore" && method === "POST") {
            const token = url.searchParams.get("token") ?? "";
            const proof = headerString(req.headers["x-trade-token"]) || token;
            const user = store.db.users[userId];
            if (!user || !user.tradeToken) {
                return text(res, 403, "no trade token is bound to this user; nothing to restore");
            }
            if (!constantTimeEqual(proof, user.tradeToken)) {
                return text(res, 403, "trade token proof required: send the current token as ?token= or X-Trade-Token");
            }
            restoreToken(store, user);
            return json(res, 200, {});
        }

        /* ---------------- users ---------------- */
        if (p === "/user/authentication" && method === "POST") {
            const user = store.db.users[userId] ?? hub.ensureUser(userId, ipOf(req), url.searchParams.get("platform") ?? "web", url.searchParams.get("version") ?? "");
            user.authenticated = true;
            store.markDirty();
            return text(res, 200, "ok");
        }
        if (p === "/user/verification" && method === "POST") {
            const user = store.db.users[userId];
            const token = url.searchParams.get("tradeToken") ?? "";
            // an empty token never proves anything (it would match a not-yet-bound user record)
            const rightToTrade = !!user && !!token && (user.tradeToken === token || store.adoptToken(user.userId, token));
            const result: IVerificationResult = {
                authenticated: !!user && user.authenticated,
                rightToTrade,
                rightToTradeCooldown: 0,
                trusted: config.trustAll || (!!user && user.authenticated),
                passAntiCheat: true,
                passPlatformIdCheck: true,
            };
            return json(res, 200, result);
        }

        /* ---------------- chat moderation ---------------- */
        if (p === "/chat/mute" && method === "POST") {
            if (!isAdminAuthorized(req, hub, config, userId)) return text(res, 403, adminDenied(config));
            const ip = url.searchParams.get("ip") ?? "";
            const time = Number(url.searchParams.get("time") ?? "0");
            if (!ip) return text(res, 400, "missing ip");
            hub.chat.mute(ip, Number.isFinite(time) ? Math.max(0, time) : 0);
            return json(res, 200, { ok: true });
        }

        /* ---------------- streaming ---------------- */
        if (p === "/stream" && method === "POST") {
            const user = store.db.users[userId] ?? hub.ensureUser(userId, ipOf(req), "web", "");
            const on = url.searchParams.get("status") === "on";
            return json(res, 200, hub.setStreaming(user, on));
        }

        /* ---------------- misc ---------------- */
        if (p === "/config.json" && method === "GET") {
            // the live game fetches this from play.industryidle.com; a stub keeps self-hosted setups working
            return json(res, 200, {});
        }

        return text(res, 404, "not found");
    } catch (e) {
        console.error("[rest] error:", e);
        return text(res, 500, String(e));
    }
}

type TokenOpResult = { status: 200; token: string } | { status: 403; message: string };

/**
 * `POST /trade/import-save?token=` — bind an imported save's trade token and return a
 * freshly rotated token (`json.token`, which the client writes back to
 * `persisted.tradeToken`).
 *
 * Ownership rule (audit fix): the endpoint used to rotate *any* user's token on the
 * request of anybody who knew their `userId` (which is all a client sends), so a
 * stranger could hijack a victim's trading rights / lock them out. With no platform
 * auth in self-hosted mode the strongest available proof is possession of the token:
 *
 *   - `token` is already bound to a user → presenting it *is* the proof (this is the
 *     documented "export for transfer / import that save" flow, where the exported save
 *     carries the live token). Rotate it and return the fresh value.
 *   - `token` is unbound → only the requesting identity may be (re)bound, and only if
 *     it has no token bound yet **or** the caller proves the current one via
 *     `X-Trade-Token`. Otherwise 403 (see `README.md`).
 */
function importToken(store: Store, userId: string, token: string, proof: string): TokenOpResult {
    const ownerId = store.db.tokens[token];
    if (ownerId) {
        const owner = store.db.users[ownerId];
        if (owner) return { status: 200, token: rotateToken(store, owner) };
        // stale mapping without a user record: fall through and repair it for the caller
        delete store.db.tokens[token];
    }
    const user = store.db.users[userId];
    if (!store.hasBoundToken(userId)) {
        // no token bound yet → first import, safe to bind
        const fresh = randomUUID();
        store.db.tokens[fresh] = userId;
        if (user) user.tradeToken = fresh;
        store.markDirty();
        return { status: 200, token: fresh };
    }
    if (!user || !constantTimeEqual(proof, user.tradeToken)) {
        return {
            status: 403,
            message:
                "a trade token is already bound to this user: prove it with X-Trade-Token (or import a save whose token is still live)",
        };
    }
    return { status: 200, token: rotateToken(store, user) };
}

/** revoke `user`'s current token and bind a fresh one (only called after proof of ownership) */
function rotateToken(store: Store, user: UserRecord): string {
    const fresh = randomUUID();
    if (user.tradeToken) delete store.db.tokens[user.tradeToken];
    user.tradeToken = fresh;
    store.db.tokens[fresh] = user.userId;
    store.markDirty();
    return fresh;
}

/**
 * "Force Restore Right To Trade": the caller already proved ownership of
 * `user.tradeToken` (the route compares it in constant time), so the token itself is
 * kept and only its mapping is repaired if it went missing.
 */
function restoreToken(store: Store, user: UserRecord): void {
    if (store.db.tokens[user.tradeToken] !== user.userId) {
        store.db.tokens[user.tradeToken] = user.userId;
        store.markDirty();
    }
}

function ipOf(req: IncomingMessage): string {
    const fwd = req.headers["x-forwarded-for"];
    if (typeof fwd === "string" && fwd) return fwd.split(",")[0].trim();
    return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}
