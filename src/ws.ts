/**
 * WebSocket hub — connection registry + message dispatch.
 *
 * Protocol summary (all messages are JSON text frames; see `src/net/Socket.ts` on the client):
 *
 * **client → server**
 * | type | payload | notes |
 * |---|---|---|
 * | `join` | `{ channel, streaming }` | sent right after connect and on channel switch |
 * | `chat` | `{ user, dlc, flag, message, channel }` | rate limited + muted by ip |
 * | `trade` | signed `ITradeRequest` | routed to `TradeService` |
 * | `tick` | `getTickMessage()` | leaderboard snapshot; gets a heartbeat reply (the client force-reconnects without one) |
 * | `pledge` | `{ pledge: Record<projectId, IPledge[]> }` | crowdfunding aggregation |
 * | `export` | `{ data }` | full save dump (debug), stored under `data/saves/` (capped by `maxExportBytes`) |
 * | `signal` | WebRTC relay payload | routed by stream `token` / `key` |
 *
 * **server → client**
 * | type | payload |
 * |---|---|
 * | `join` | `{ messages }` chat history of the channel |
 * | `chat` | one message (`ip` only for mods) |
 * | `trade` | `{ flush / add / delete / myTrades / error / id }` |
 * | `pledge` | `{ pledge: Record<"id.index", total> }` |
 * | `streaming` | `{ users: Record<token, IStreamingUser> }` |
 * | `signal` | relayed payload + `key` |
 * | `tradeFine` | `{ fines }` (this server never issues fines, kept for compatibility) |
 *
 * ⚠️ Every server message must carry `isMod` — the client resets its moderator flag on
 * any message that lacks it — and `time`, which keeps the client's `ServerClock` in sync.
 */

import fs from "node:fs";
import path from "node:path";
import type { WebSocket } from "ws";
import type { ServerConfig } from "./config";
import { ChatService } from "./chat";
import { TradeService } from "./trade";
import { computeBoard, ingestTick } from "./leaderboard";
import type { Store, UserRecord, ChatRecord } from "./store";
import type { IChatMessage, IStreamingUser, IPledge } from "./types";
import { boundedInt, boundedNumber, clampString, finiteNumber, sanitizeChannel } from "./validation";

export interface LiveConn {
    ws: WebSocket;
    userId: string;
    ip: string;
    isMod: boolean;
    channel: string;
    send(message: Record<string, unknown>): void;
    close(code?: number, reason?: string): void;
}

/** messages with these keys are WebRTC relay payloads routed by `key` */
const SIGNAL_KEYS = ["init", "cancelInit", "answer", "offer", "candidate", "reject", "connected", "failed", "issueKey"];

export class Hub {
    public readonly trades: TradeService;
    public readonly chat: ChatService;

    private readonly conns = new Map<string, Set<LiveConn>>();
    /** WebRTC session key → { streamer, audience } user ids */
    private readonly signalRoutes = new Map<string, { streamer: string; audience: string; createdAt: number }>();
    /** per-connection message budget */
    private readonly rateBuckets = new Map<LiveConn, { tokens: number; last: number }>();
    /** last `export` time per user (upload quota) */
    private readonly exportTimes = new Map<string, number>();
    /** leaderboard responses, keyed by board name */
    private readonly boardCache = new Map<string, { at: number; value: ReturnType<typeof computeBoard> }>();

    constructor(
        private readonly store: Store,
        private readonly config: ServerConfig
    ) {
        this.trades = new TradeService(store, config, {
            sendToUser: (userId, message) => this.sendToUser(userId, message),
            broadcast: (message, exceptUserId) => this.broadcast(message, exceptUserId),
        });
        this.chat = new ChatService(store, config);
    }

    /** Compute a board, reusing the previous response for `leaderboardCacheMs`. */
    public leaderboard(name: string): ReturnType<typeof computeBoard> {
        const ttl = this.config.leaderboardCacheMs;
        const now = Date.now();
        if (ttl > 0) {
            const cached = this.boardCache.get(name);
            if (cached && now - cached.at < ttl) return cached.value;
        }
        const value = computeBoard(this.store.db, name);
        if (ttl > 0) this.boardCache.set(name, { at: now, value });
        return value;
    }

    /* ---------------- user / moderation helpers ---------------- */

    public isMod(userId: string): boolean {
        return this.config.mods.includes("*") || this.config.mods.includes(userId);
    }

    public hasUser(userId: string): boolean {
        return !!this.store.db.users[userId];
    }

    public userCount(): number {
        return Object.keys(this.store.db.users).length;
    }

    /** get-or-create the user record for a websocket handshake */
    public ensureUser(userId: string, ip: string, platform: string, version: string): UserRecord {
        let user = this.store.db.users[userId];
        if (!user) {
            user = {
                userId,
                // no client token has been seen yet; it is bound on first trade /
                // verification (`store.adoptToken`). A server-generated placeholder would
                // make every user look "already bound" and defeat the import-save check.
                tradeToken: "",
                userName: userId.substring(0, 6).toUpperCase(),
                flag: "earth",
                dlc: 0,
                authenticated: this.config.trustAll,
                createdAt: Date.now(),
                lastSeenAt: Date.now(),
                ip,
                platform,
                version,
            };
            this.store.db.users[userId] = user;
            this.store.markDirty();
        } else {
            user.lastSeenAt = Date.now();
            user.ip = ip;
        }
        return user;
    }

    /* ---------------- connection lifecycle ---------------- */

    /** Per-connection token bucket; returns false when the message must be dropped. */
    private takeRateToken(conn: LiveConn): boolean {
        const limit = this.config.wsRateLimitPerSecond;
        if (limit <= 0) return true;
        const now = Date.now();
        let bucket = this.rateBuckets.get(conn);
        if (!bucket) {
            bucket = { tokens: limit, last: now };
            this.rateBuckets.set(conn, bucket);
        }
        bucket.tokens = Math.min(limit, bucket.tokens + ((now - bucket.last) / 1000) * limit);
        bucket.last = now;
        if (bucket.tokens < 1) return false;
        bucket.tokens -= 1;
        return true;
    }

    public addConnection(conn: LiveConn): void {
        let set = this.conns.get(conn.userId);
        if (!set) {
            set = new Set();
            this.conns.set(conn.userId, set);
        }
        set.add(conn);
    }

    public removeConnection(conn: LiveConn): void {
        this.rateBuckets.delete(conn);
        const set = this.conns.get(conn.userId);
        if (set) {
            set.delete(conn);
            if (set.size === 0) this.conns.delete(conn.userId);
        }
        // drop WebRTC sessions of this user
        for (const [key, route] of this.signalRoutes) {
            if (route.audience === conn.userId || route.streamer === conn.userId) {
                this.signalRoutes.delete(key);
            }
        }
    }

    /* ---------------- envelope ---------------- */

    private decorate(message: Record<string, unknown>, conn: LiveConn): Record<string, unknown> {
        const user = this.store.db.users[conn.userId];
        return {
            ...message,
            time: Date.now(),
            isMod: conn.isMod,
            ...(user ? { auth: user.authenticated } : {}),
        };
    }

    public sendToUser(userId: string, message: Record<string, unknown>): void {
        const set = this.conns.get(userId);
        if (!set) return;
        for (const conn of set) {
            conn.send(this.decorate(message, conn));
        }
    }

    public broadcast(message: Record<string, unknown>, exceptUserId?: string): void {
        for (const [userId, set] of this.conns) {
            if (userId === exceptUserId) continue;
            for (const conn of set) {
                conn.send(this.decorate(message, conn));
            }
        }
    }

    private broadcastChannel(channel: string, message: Record<string, unknown>): void {
        for (const set of this.conns.values()) {
            for (const conn of set) {
                if (conn.channel === channel) {
                    conn.send(this.decorate(message, conn));
                }
            }
        }
    }

    /* ---------------- message dispatch ---------------- */

    public handleRaw(conn: LiveConn, raw: string): void {
        if (!this.takeRateToken(conn)) {
            conn.close(1008, "rate limit");
            return;
        }
        let msg: Record<string, unknown>;
        try {
            msg = JSON.parse(raw);
        } catch {
            return;
        }
        try {
            this.handle(conn, msg);
        } catch (e) {
            console.error("[ws] failed to handle message:", e);
            if (typeof msg.id === "string") {
                conn.send(this.decorate({ type: msg.type, id: msg.id, error: String(e) }, conn));
            }
        }
    }

    public handle(conn: LiveConn, msg: Record<string, unknown>): void {
        const user = this.store.db.users[conn.userId];
        switch (msg.type) {
            case "join":
                this.handleJoin(conn, user, msg);
                break;
            case "chat":
                this.handleChat(conn, user, msg);
                break;
            case "trade":
                this.handleTrade(conn, user, msg);
                break;
            case "tick":
                this.handleTick(conn, user, msg);
                break;
            case "pledge":
                this.handlePledge(conn, msg);
                break;
            case "export":
                this.handleExport(conn, msg);
                break;
            case "signal":
                this.handleSignal(conn, msg);
                break;
            default:
                break;
        }
    }

    /* ---------------- join ---------------- */

    private handleJoin(conn: LiveConn, user: UserRecord, msg: Record<string, unknown>): void {
        const channel = sanitizeChannel(msg.channel);
        conn.channel = channel;
        // chat history (mods see sender ips for the mute UI)
        const messages = this.chat.history(channel).map((m) => this.chatMessage(m, conn.isMod));
        conn.send(this.decorate({ type: "join", messages }, conn));
        // full market + personal order state
        conn.send(
            this.decorate(
                { type: "trade", myTrades: this.trades.myTrades(conn.userId), flush: this.trades.activeTrades() },
                conn
            )
        );
        // crowdfunding totals + discoverable streamers
        conn.send(this.decorate({ type: "pledge", pledge: { ...this.store.db.pledges } }, conn));
        conn.send(this.decorate({ type: "streaming", users: this.streamingUsers() }, conn));
    }

    private chatMessage(m: ChatRecord, withIp: boolean): IChatMessage {
        return {
            type: "chat",
            user: m.user,
            message: m.message,
            dlc: m.dlc,
            flag: m.flag,
            channel: m.channel,
            time: m.time,
            ...(withIp ? { ip: m.ip } : {}),
        };
    }

    /* ---------------- chat ---------------- */

    private handleChat(conn: LiveConn, user: UserRecord, msg: Record<string, unknown>): void {
        // the chat message carries the player's current display name / flag / dlc
        // (they are changeable in-game), so refresh the user record from it
        user.userName = clampString(msg.user, 24, user.userName);
        user.flag = clampString(msg.flag, 24, user.flag);
        user.dlc = boundedInt(msg.dlc, 0, 100, user.dlc);
        const result = this.chat.handleChat(user, msg as { message?: unknown; channel?: unknown });
        if (typeof result === "string") {
            return; // rate-limited / muted / invalid: silently dropped (the client sends without `id`)
        }
        for (const set of this.conns.values()) {
            for (const target of set) {
                if (target.channel === result.channel) {
                    target.send(this.decorate({ ...this.chatMessage(result, target.isMod) }, target));
                }
            }
        }
    }

    /* ---------------- trade ---------------- */

    private handleTrade(conn: LiveConn, user: UserRecord, msg: Record<string, unknown>): void {
        const reply = this.trades.handleMessage(user, msg as never);
        conn.send(this.decorate(reply, conn));
    }

    /* ---------------- tick / leaderboard ---------------- */

    private handleTick(conn: LiveConn, user: UserRecord, msg: Record<string, unknown>): void {
        const userName = clampString(msg.userName, 64, user.userName);
        const flag = clampString(msg.flag, 64, user.flag);
        ingestTick(this.store.db, {
            userId: user.userId,
            userName,
            flag,
            dlc: boundedInt(msg.dlc, 0, 100, user.dlc),
            map: clampString(msg.map, 64),
            mapCreatedAt: boundedNumber(msg.mapCreatedAt, 0, 8.64e15),
            cash: finiteNumber(msg.cash),
            resourceValuation: finiteNumber(msg.resourceValuation),
            resourceValuationForReference: finiteNumber(msg.resourceValuationForReference),
            buildingValuation: finiteNumber(msg.buildingValuation),
            buildingCount: boundedInt(msg.buildingCount, 0, 1e9),
            prestigeCurrency: finiteNumber(msg.prestigeCurrency),
            allPrestigeCurrency: finiteNumber(msg.allPrestigeCurrency),
            optOut: msg.optOut === true,
        });
        user.userName = userName;
        user.flag = flag;
        user.dlc = boundedInt(msg.dlc, 0, 100, user.dlc);
        user.lastSeenAt = Date.now();
        this.store.markDirty();
        // heartbeat: the client force-reconnects when it receives nothing for ~70s,
        // so answer every tick with an idempotent state push
        conn.send(this.decorate({ type: "streaming", users: this.streamingUsers() }, conn));
    }

    /* ---------------- crowdfunding pledges ---------------- */

    private handlePledge(conn: LiveConn, msg: Record<string, unknown>): void {
        const pledge = msg.pledge;
        if (!pledge || typeof pledge !== "object" || Array.isArray(pledge)) return;
        const entries = Object.entries(pledge as Record<string, unknown>);
        if (entries.length > 256) return;
        // aggregate by `${projectId}.${index}` (see CrowdfundingPage: `G.socket.pledge[id + "." + index]`)
        for (const [rawProjectId, list] of entries) {
            // reject overlong ids instead of truncating: truncation would merge unrelated projects
            if (rawProjectId.length > 64) continue;
            const projectId = clampString(rawProjectId, 64);
            if (!projectId || !Array.isArray(list) || list.length > 100) continue;
            for (const p of list) {
                if (!p || typeof p !== "object") continue;
                const entry = p as IPledge;
                if (typeof entry.resource !== "string" || entry.resource.length > 64) continue;
                const index = boundedInt(entry.index, 0, 1_000_000, -1);
                if (index < 0) continue;
                const amount = boundedNumber(entry.amount, 0, 1e30);
                const key = `${projectId}.${index}`;
                if (this.store.db.pledges[key] === undefined && Object.keys(this.store.db.pledges).length >= 10_000) continue;
                this.store.db.pledges[key] = (this.store.db.pledges[key] ?? 0) + amount;
            }
        }
        this.store.markDirty();
        // full replacement record (the client assigns `this.pledge = resp.pledge`)
        conn.send(this.decorate({ type: "pledge", id: msg.id, pledge: { ...this.store.db.pledges } }, conn));
    }

    /* ---------------- save export (debug) ---------------- */

    private handleExport(conn: LiveConn, msg: Record<string, unknown>): void {
        try {
            const raw = JSON.stringify(msg.data ?? null);
            const size = Buffer.byteLength(raw, "utf8");
            const limit = this.config.maxExportBytes;
            if (limit > 0 && size > limit) {
                // Reject without writing. NOTE: do NOT answer with a `type: "export"`
                // message — `Socket.handleExport` re-uploads on every export message it
                // receives, so an error echo would loop. The upload is fire-and-forget,
                // so a server-side warning is the only safe feedback channel.
                console.warn(`[export] rejected oversized save from ${conn.userId}: ${size} bytes > limit ${limit} bytes`);
                return;
            }
            const now = Date.now();
            const last = this.exportTimes.get(conn.userId) ?? 0;
            if (now - last < this.config.exportMinIntervalMs) {
                console.warn(`[export] rate-limited save from ${conn.userId}`);
                return;
            }
            this.exportTimes.set(conn.userId, now);
            const dir = path.join(this.config.dataDir, "saves");
            // `conn.userId` comes straight from the WS query string: never let it escape `saves/`
            const file = path.join(dir, `${safeFileSegment(conn.userId)}-${now}-${newToken().slice(0, 8)}.json`);
            // Async: an 8 MB dump must not block the event loop for every other connection.
            void fs.promises
                .mkdir(dir, { recursive: true })
                .then(() => fs.promises.writeFile(file, raw))
                .then(() => console.log(`[export] stored save of ${conn.userId} → ${file} (${size} bytes)`))
                .catch((e) => console.error("[export] failed to store save:", e));
        } catch (e) {
            console.error("[export] failed to store save:", e);
        }
    }

    /* ---------------- streaming registry + WebRTC relay ---------------- */

    public streamingUsers(): Record<string, IStreamingUser> {
        const users: Record<string, IStreamingUser> = {};
        for (const s of Object.values(this.store.db.streams)) {
            users[s.token] = s.user;
        }
        return users;
    }

    /** POST /stream?status=on|off */
    public setStreaming(user: UserRecord, on: boolean): { streaming: boolean; token?: string } {
        if (!on) {
            delete this.store.db.streams[user.userId];
            this.store.markDirty();
            this.broadcast({ type: "streaming", users: this.streamingUsers() });
            return { streaming: false };
        }
        const existing = this.store.db.streams[user.userId];
        const record = existing ?? {
            userId: user.userId,
            token: newToken(),
            user: { name: user.userName, dlc: user.dlc, flag: user.flag },
            since: Date.now(),
        };
        record.user = { name: user.userName, dlc: user.dlc, flag: user.flag };
        this.store.db.streams[user.userId] = record;
        this.store.markDirty();
        this.broadcast({ type: "streaming", users: this.streamingUsers() });
        return { streaming: true, token: record.token };
    }

    private handleSignal(conn: LiveConn, msg: Record<string, unknown>): void {
        // audience → streamer: request a new WebRTC session key, addressed by stream token
        if (msg.init && typeof msg.token === "string") {
            if (msg.token.length > 128) return;
            // `token` is the streamer's **streaming** token (issued by POST /stream), not the trade token
            const streamer = Object.values(this.store.db.streams).find((s) => s.token === msg.token)?.userId;
            if (!streamer) return;
            let sessions = 0;
            for (const route of this.signalRoutes.values()) {
                if (route.streamer === conn.userId || route.audience === conn.userId) sessions++;
            }
            if (sessions >= 32) return;
            const key = newToken();
            this.signalRoutes.set(key, { streamer, audience: conn.userId, createdAt: Date.now() });
            this.sendToUser(streamer, { type: "signal", init: true, key, user: msg.user });
            conn.send(this.decorate({ type: "signal", issueKey: true, key }, conn));
            return;
        }
        if (typeof msg.key !== "string" || msg.key.length > 128) return;
        const route = this.signalRoutes.get(msg.key);
        if (!route) return;
        // relay to the other side of the session
        const target = route.streamer === conn.userId ? route.audience : route.streamer;
        const relay: Record<string, unknown> = { ...msg, type: "signal" };
        delete relay.time;
        delete relay.isMod;
        delete relay.auth;
        this.sendToUser(target, relay);
        if (msg.cancelInit || msg.reject || msg.failed) {
            this.signalRoutes.delete(msg.key);
        }
    }

    /** periodic keep-alive (also refreshes the client's server clock) */
    public heartbeat(): void {
        const now = Date.now();
        for (const [key, route] of this.signalRoutes) {
            if (now - route.createdAt > 10 * 60 * 1000) this.signalRoutes.delete(key);
        }
        for (const [userId, at] of this.exportTimes) {
            if (now - at > 60 * 60 * 1000) this.exportTimes.delete(userId);
        }
        const retention = this.config.snapshotRetentionMs;
        if (retention > 0) {
            for (const [userId, snapshot] of Object.entries(this.store.db.snapshots)) {
                if (now - snapshot.updatedAt > retention) delete this.store.db.snapshots[userId];
            }
        }
        this.broadcast({ type: "streaming", users: this.streamingUsers() });
    }
}

function newToken(): string {
    return globalThis.crypto.randomUUID();
}

/** turn a client-supplied user id into a safe single path segment (no `/`, `..`, …) */
export function safeFileSegment(value: string): string {
    const cleaned = value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
    return cleaned.slice(0, 64) || "anonymous";
}
