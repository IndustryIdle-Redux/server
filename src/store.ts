/**
 * Persistence layer — SQLite (`node:sqlite`, WAL mode).
 *
 * The whole database still lives in memory (the game server is single-process and every
 * read path wants it that way); SQLite is the durable store behind it. Mutations go
 * through the `save…` methods below, which queue the touched rows and a debounced flush
 * writes only those rows in one transaction. That avoids the old full-document rewrite
 * (`JSON.stringify` of the whole database on every save).
 *
 * Requires Node >= 22.5 for `node:sqlite`. The database file is `data/db.sqlite`.
 */

import fs from "node:fs";
import { createRequire as createNodeRequire } from "node:module";
import path from "node:path";
import type { DatabaseSync as DatabaseSyncType } from "node:sqlite";
import type { IStreamingUser } from "./types";

// `node:sqlite` is a builtin, but the Vite version used by vitest does not know it and
// tries to resolve a package called "sqlite". Loading it through createRequire keeps the
// runtime resolution in Node (and esbuild leaves the call alone).
const nodeRequire = createNodeRequire(import.meta.url);
const { DatabaseSync } = nodeRequire("node:sqlite") as { DatabaseSync: typeof import("node:sqlite").DatabaseSync };

export interface UserRecord {
    userId: string;
    /** the "right to trade" token; trade messages must carry it */
    tradeToken: string;
    userName: string;
    flag: string;
    dlc: number;
    /** set by POST /user/authentication */
    authenticated: boolean;
    createdAt: number;
    lastSeenAt: number;
    ip: string;
    platform: string;
    version: string;
    /** current trade-fine state is not persisted per user; fines are computed per session */
}

export interface TradeRecord {
    id: string;
    type: "trade";
    side: "buy" | "sell";
    resource: string;
    amount: number;
    price: number;
    from: string;
    fromUserHash: string;
    fromUserId: string;
    fillBy: string | null;
    filledByUserId: string | null;
    status: "open" | "filled" | "closed" | "cancelled";
    /**
     * For a fill record: the id of the open order it was taken from. `null`/absent for
     * orders and for records written before partial fills were supported.
     */
    parentId?: string | null;
    createdAt: number;
    /**
     * server receive time — used by the stale-order sweep so a client cannot evade it
     * (or trigger it) by forging `createdAt`. Optional for records written by older builds.
     */
    openedAt?: number;
    filledAt: number | null;
    closedAt: number | null;
}

export interface ChatRecord {
    user: string;
    userId: string;
    message: string;
    dlc: number;
    flag: string;
    channel: string;
    time: number;
    ip: string;
}

export interface TickSnapshot {
    userId: string;
    userName: string;
    flag: string;
    dlc: number;
    map: string;
    mapCreatedAt: number;
    cash: number;
    resourceValuation: number;
    resourceValuationForReference: number;
    buildingValuation: number;
    buildingCount: number;
    prestigeCurrency: number;
    allPrestigeCurrency: number;
    optOut: boolean;
    /** `resourceValuation + buildingValuation` — matches the client's `getValuation()` */
    valuation: number;
    /** smoothed hourly growth of `valuation`, maintained by `leaderboard.ts` */
    valuationPerHour: number;
    updatedAt: number;
}

export interface StreamRecord {
    userId: string;
    token: string;
    user: IStreamingUser;
    since: number;
}

export interface Db {
    users: Record<string, UserRecord>;
    /** tradeToken → userId (tokens are unique; a token can move between users on save import) */
    tokens: Record<string, string>;
    /** live order book + pending claims, keyed by trade id */
    trades: Record<string, TradeRecord>;
    /** settled orders (closed / cancelled / swept), newest appended last */
    history: TradeRecord[];
    /** chat history per channel */
    chat: Record<string, ChatRecord[]>;
    /** crowdfunding totals, keyed `${projectId}.${resourceIndex}` */
    pledges: Record<string, number>;
    /** muted ips: ip → unmute timestamp */
    mutes: Record<string, number>;
    /** latest tick per user (leaderboard source) */
    snapshots: Record<string, TickSnapshot>;
    /** discoverable streamers */
    streams: Record<string, StreamRecord>;
}

function emptyDb(): Db {
    return {
        users: {},
        tokens: {},
        trades: {},
        history: [],
        chat: {},
        pledges: {},
        mutes: {},
        snapshots: {},
        streams: {},
    };
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT PRIMARY KEY,
    trade_token TEXT NOT NULL,
    user_name TEXT NOT NULL,
    flag TEXT NOT NULL,
    dlc INTEGER NOT NULL,
    authenticated INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    ip TEXT NOT NULL,
    platform TEXT NOT NULL,
    version TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tokens (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS trades (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    side TEXT NOT NULL,
    resource TEXT NOT NULL,
    amount REAL NOT NULL,
    price REAL NOT NULL,
    from_name TEXT NOT NULL,
    from_user_hash TEXT NOT NULL,
    from_user_id TEXT NOT NULL,
    fill_by TEXT,
    filled_by_user_id TEXT,
    status TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    opened_at INTEGER,
    filled_at INTEGER,
    closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS trades_from_user ON trades(from_user_id, status);
CREATE INDEX IF NOT EXISTS trades_status ON trades(status);
CREATE TABLE IF NOT EXISTS history (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    side TEXT NOT NULL,
    resource TEXT NOT NULL,
    amount REAL NOT NULL,
    price REAL NOT NULL,
    from_name TEXT NOT NULL,
    from_user_hash TEXT NOT NULL,
    from_user_id TEXT NOT NULL,
    fill_by TEXT,
    filled_by_user_id TEXT,
    status TEXT NOT NULL,
    parent_id TEXT,
    created_at INTEGER NOT NULL,
    opened_at INTEGER,
    filled_at INTEGER,
    closed_at INTEGER
);
CREATE INDEX IF NOT EXISTS history_from_user ON history(from_user_id, closed_at);
CREATE TABLE IF NOT EXISTS chat (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    channel TEXT NOT NULL,
    user_name TEXT NOT NULL,
    user_id TEXT NOT NULL,
    message TEXT NOT NULL,
    dlc INTEGER NOT NULL,
    flag TEXT NOT NULL,
    ts INTEGER NOT NULL,
    ip TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS chat_channel ON chat(channel, id);
CREATE TABLE IF NOT EXISTS pledges (
    pledge_key TEXT PRIMARY KEY,
    total REAL NOT NULL
);
CREATE TABLE IF NOT EXISTS mutes (
    ip TEXT PRIMARY KEY,
    until_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS snapshots (
    user_id TEXT PRIMARY KEY,
    user_name TEXT NOT NULL,
    flag TEXT NOT NULL,
    dlc INTEGER NOT NULL,
    map TEXT NOT NULL,
    map_created_at INTEGER NOT NULL,
    cash REAL NOT NULL,
    resource_valuation REAL NOT NULL,
    resource_valuation_for_reference REAL NOT NULL,
    building_valuation REAL NOT NULL,
    building_count INTEGER NOT NULL,
    prestige_currency REAL NOT NULL,
    all_prestige_currency REAL NOT NULL,
    opt_out INTEGER NOT NULL,
    valuation REAL NOT NULL,
    valuation_per_hour REAL NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS snapshots_valuation ON snapshots(valuation);
CREATE INDEX IF NOT EXISTS snapshots_valuation_per_hour ON snapshots(valuation_per_hour);
CREATE TABLE IF NOT EXISTS streams (
    user_id TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    name TEXT NOT NULL,
    dlc INTEGER NOT NULL,
    flag TEXT NOT NULL,
    since INTEGER NOT NULL
);
`;

export class Store {
    public db: Db = emptyDb();
    private readonly sqlite: DatabaseSyncType;
    private readonly stmts = new Map<string, ReturnType<DatabaseSyncType["prepare"]>>();
    private saveTimer: NodeJS.Timeout | null = null;
    private closed = false;

    private readonly dirtyUsers = new Set<string>();
    private readonly dirtyTokens = new Set<string>();
    private readonly deletedTokens = new Set<string>();
    private readonly dirtyTrades = new Set<string>();
    private readonly deletedTrades = new Set<string>();
    private readonly dirtyHistory = new Map<string, TradeRecord>();
    private readonly deletedHistory = new Set<string>();
    private readonly dirtyChat = new Set<string>();
    private readonly dirtyPledges = new Set<string>();
    private readonly dirtyMutes = new Set<string>();
    private readonly deletedMutes = new Set<string>();
    private readonly dirtySnapshots = new Set<string>();
    private readonly deletedSnapshots = new Set<string>();
    private readonly dirtyStreams = new Set<string>();
    private readonly deletedStreams = new Set<string>();
    private historyPruneTo: number | null = null;

    constructor(dataDir: string) {
        fs.mkdirSync(dataDir, { recursive: true });
        this.sqlite = new DatabaseSync(path.join(dataDir, "db.sqlite"));
        this.sqlite.exec("PRAGMA journal_mode = WAL");
        this.sqlite.exec("PRAGMA synchronous = NORMAL");
        this.sqlite.exec("PRAGMA busy_timeout = 5000");
        this.sqlite.exec(SCHEMA);
        this.load();
    }

    private stmt(sql: string): ReturnType<DatabaseSyncType["prepare"]> {
        let statement = this.stmts.get(sql);
        if (!statement) {
            statement = this.sqlite.prepare(sql);
            this.stmts.set(sql, statement);
        }
        return statement;
    }

    private load(): void {
        const db = emptyDb();
        for (const row of this.sqlite.prepare("SELECT * FROM users").all()) {
            const r = row as Record<string, unknown>;
            db.users[r.user_id as string] = {
                userId: r.user_id as string,
                tradeToken: r.trade_token as string,
                userName: r.user_name as string,
                flag: r.flag as string,
                dlc: Number(r.dlc),
                authenticated: Number(r.authenticated) !== 0,
                createdAt: Number(r.created_at),
                lastSeenAt: Number(r.last_seen_at),
                ip: r.ip as string,
                platform: r.platform as string,
                version: r.version as string,
            };
        }
        for (const row of this.sqlite.prepare("SELECT * FROM tokens").all()) {
            const r = row as Record<string, unknown>;
            db.tokens[r.token as string] = r.user_id as string;
        }
        const readTrade = (row: Record<string, unknown>): TradeRecord => ({
            id: row.id as string,
            type: "trade",
            side: row.side as TradeRecord["side"],
            resource: row.resource as string,
            amount: Number(row.amount),
            price: Number(row.price),
            from: row.from_name as string,
            fromUserHash: row.from_user_hash as string,
            fromUserId: row.from_user_id as string,
            fillBy: (row.fill_by as string) ?? null,
            filledByUserId: (row.filled_by_user_id as string) ?? null,
            status: row.status as TradeRecord["status"],
            parentId: (row.parent_id as string) ?? null,
            createdAt: Number(row.created_at),
            openedAt: row.opened_at === null ? undefined : Number(row.opened_at),
            filledAt: row.filled_at === null ? null : Number(row.filled_at),
            closedAt: row.closed_at === null ? null : Number(row.closed_at),
        });
        for (const row of this.sqlite.prepare("SELECT * FROM trades").all()) {
            const record = readTrade(row as Record<string, unknown>);
            db.trades[record.id] = record;
        }
        for (const row of this.sqlite.prepare("SELECT * FROM history ORDER BY rowid").all()) {
            db.history.push(readTrade(row as Record<string, unknown>));
        }
        for (const row of this.sqlite.prepare("SELECT * FROM chat ORDER BY id").all()) {
            const r = row as Record<string, unknown>;
            const record: ChatRecord = {
                user: r.user_name as string,
                userId: r.user_id as string,
                message: r.message as string,
                dlc: Number(r.dlc),
                flag: r.flag as string,
                channel: r.channel as string,
                time: Number(r.ts),
                ip: r.ip as string,
            };
            (db.chat[record.channel] ??= []).push(record);
        }
        for (const row of this.sqlite.prepare("SELECT * FROM pledges").all()) {
            const r = row as Record<string, unknown>;
            db.pledges[r.pledge_key as string] = Number(r.total);
        }
        for (const row of this.sqlite.prepare("SELECT * FROM mutes").all()) {
            const r = row as Record<string, unknown>;
            db.mutes[r.ip as string] = Number(r.until_at);
        }
        for (const row of this.sqlite.prepare("SELECT * FROM snapshots").all()) {
            const r = row as Record<string, unknown>;
            db.snapshots[r.user_id as string] = {
                userId: r.user_id as string,
                userName: r.user_name as string,
                flag: r.flag as string,
                dlc: Number(r.dlc),
                map: r.map as string,
                mapCreatedAt: Number(r.map_created_at),
                cash: Number(r.cash),
                resourceValuation: Number(r.resource_valuation),
                resourceValuationForReference: Number(r.resource_valuation_for_reference),
                buildingValuation: Number(r.building_valuation),
                buildingCount: Number(r.building_count),
                prestigeCurrency: Number(r.prestige_currency),
                allPrestigeCurrency: Number(r.all_prestige_currency),
                optOut: Number(r.opt_out) !== 0,
                valuation: Number(r.valuation),
                valuationPerHour: Number(r.valuation_per_hour),
                updatedAt: Number(r.updated_at),
            };
        }
        for (const row of this.sqlite.prepare("SELECT * FROM streams").all()) {
            const r = row as Record<string, unknown>;
            db.streams[r.user_id as string] = {
                userId: r.user_id as string,
                token: r.token as string,
                user: { name: r.name as string, dlc: Number(r.dlc), flag: r.flag as string },
                since: Number(r.since),
            };
        }
        this.db = db;
    }

    private schedule(): void {
        if (this.saveTimer || this.closed) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushSync();
        }, 500);
        // do not keep the process alive just for a pending save
        this.saveTimer.unref?.();
    }

    /* ---------------- dirty tracking ---------------- */

    public saveUser(user: UserRecord): void {
        this.dirtyUsers.add(user.userId);
        this.schedule();
    }
    public saveToken(token: string, userId: string): void {
        this.deletedTokens.delete(token);
        this.dirtyTokens.add(token);
        this.schedule();
    }
    public deleteToken(token: string): void {
        this.dirtyTokens.delete(token);
        this.deletedTokens.add(token);
        this.schedule();
    }
    public saveTrade(record: TradeRecord): void {
        this.dirtyTrades.add(record.id);
        this.schedule();
    }
    public deleteTrade(id: string): void {
        this.dirtyTrades.delete(id);
        this.deletedTrades.add(id);
        this.schedule();
    }
    public appendHistory(record: TradeRecord): void {
        this.deletedHistory.delete(record.id);
        this.dirtyHistory.set(record.id, record);
        this.schedule();
    }
    public pruneHistory(maxRows: number): void {
        this.historyPruneTo = maxRows;
        this.schedule();
    }
    public saveChatChannel(channel: string): void {
        this.dirtyChat.add(channel);
        this.schedule();
    }
    public savePledge(key: string): void {
        this.dirtyPledges.add(key);
        this.schedule();
    }
    public saveMute(ip: string): void {
        this.deletedMutes.delete(ip);
        this.dirtyMutes.add(ip);
        this.schedule();
    }
    public deleteMute(ip: string): void {
        this.dirtyMutes.delete(ip);
        this.deletedMutes.add(ip);
        this.schedule();
    }
    public saveSnapshot(snapshot: TickSnapshot): void {
        this.dirtySnapshots.add(snapshot.userId);
        this.schedule();
    }
    public deleteSnapshot(userId: string): void {
        this.dirtySnapshots.delete(userId);
        this.deletedSnapshots.add(userId);
        this.schedule();
    }
    public saveStream(record: StreamRecord): void {
        this.deletedStreams.delete(record.userId);
        this.dirtyStreams.add(record.userId);
        this.schedule();
    }
    public deleteStream(userId: string): void {
        this.dirtyStreams.delete(userId);
        this.deletedStreams.add(userId);
        this.schedule();
    }

    /** write every queued change in one transaction */
    public flushSync(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        if (this.closed) return;
        const hasRows =
            this.dirtyUsers.size +
                this.dirtyTokens.size +
                this.deletedTokens.size +
                this.dirtyTrades.size +
                this.deletedTrades.size +
                this.dirtyHistory.size +
                this.dirtyChat.size +
                this.dirtyPledges.size +
                this.dirtyMutes.size +
                this.deletedMutes.size +
                this.dirtySnapshots.size +
                this.deletedSnapshots.size +
                this.dirtyStreams.size +
                this.deletedStreams.size >
            0;
        if (!hasRows && this.historyPruneTo === null) return;

        const userStmt = this.stmt(
            `INSERT INTO users (user_id, trade_token, user_name, flag, dlc, authenticated, created_at, last_seen_at, ip, platform, version)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET trade_token=excluded.trade_token, user_name=excluded.user_name,
               flag=excluded.flag, dlc=excluded.dlc, authenticated=excluded.authenticated,
               created_at=excluded.created_at, last_seen_at=excluded.last_seen_at, ip=excluded.ip,
               platform=excluded.platform, version=excluded.version`
        );
        const tokenStmt = this.stmt(
            "INSERT INTO tokens (token, user_id) VALUES (?, ?) ON CONFLICT(token) DO UPDATE SET user_id=excluded.user_id"
        );
        const deleteTokenStmt = this.stmt("DELETE FROM tokens WHERE token = ?");
        const tradeStmt = this.stmt(
            `INSERT INTO trades (id, type, side, resource, amount, price, from_name, from_user_hash, from_user_id,
               fill_by, filled_by_user_id, status, parent_id, created_at, opened_at, filled_at, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET type=excluded.type, side=excluded.side, resource=excluded.resource,
               amount=excluded.amount, price=excluded.price, from_name=excluded.from_name,
               from_user_hash=excluded.from_user_hash, from_user_id=excluded.from_user_id,
               fill_by=excluded.fill_by, filled_by_user_id=excluded.filled_by_user_id, status=excluded.status,
               parent_id=excluded.parent_id, created_at=excluded.created_at, opened_at=excluded.opened_at,
               filled_at=excluded.filled_at, closed_at=excluded.closed_at`
        );
        const deleteTradeStmt = this.stmt("DELETE FROM trades WHERE id = ?");
        const historyStmt = this.stmt(
            `INSERT INTO history (id, type, side, resource, amount, price, from_name, from_user_hash, from_user_id,
               fill_by, filled_by_user_id, status, parent_id, created_at, opened_at, filled_at, closed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(id) DO UPDATE SET type=excluded.type, side=excluded.side, resource=excluded.resource,
               amount=excluded.amount, price=excluded.price, from_name=excluded.from_name,
               from_user_hash=excluded.from_user_hash, from_user_id=excluded.from_user_id,
               fill_by=excluded.fill_by, filled_by_user_id=excluded.filled_by_user_id, status=excluded.status,
               parent_id=excluded.parent_id, created_at=excluded.created_at, opened_at=excluded.opened_at,
               filled_at=excluded.filled_at, closed_at=excluded.closed_at`
        );
        const deleteHistoryStmt = this.stmt("DELETE FROM history WHERE id = ?");
        const deleteChatStmt = this.stmt("DELETE FROM chat WHERE channel = ?");
        const chatStmt = this.stmt(
            "INSERT INTO chat (channel, user_name, user_id, message, dlc, flag, ts, ip) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
        );
        const pledgeStmt = this.stmt(
            "INSERT INTO pledges (pledge_key, total) VALUES (?, ?) ON CONFLICT(pledge_key) DO UPDATE SET total=excluded.total"
        );
        const muteStmt = this.stmt(
            "INSERT INTO mutes (ip, until_at) VALUES (?, ?) ON CONFLICT(ip) DO UPDATE SET until_at=excluded.until_at"
        );
        const deleteMuteStmt = this.stmt("DELETE FROM mutes WHERE ip = ?");
        const snapshotStmt = this.stmt(
            `INSERT INTO snapshots (user_id, user_name, flag, dlc, map, map_created_at, cash, resource_valuation,
               resource_valuation_for_reference, building_valuation, building_count, prestige_currency,
               all_prestige_currency, opt_out, valuation, valuation_per_hour, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET user_name=excluded.user_name, flag=excluded.flag, dlc=excluded.dlc,
               map=excluded.map, map_created_at=excluded.map_created_at, cash=excluded.cash,
               resource_valuation=excluded.resource_valuation,
               resource_valuation_for_reference=excluded.resource_valuation_for_reference,
               building_valuation=excluded.building_valuation, building_count=excluded.building_count,
               prestige_currency=excluded.prestige_currency, all_prestige_currency=excluded.all_prestige_currency,
               opt_out=excluded.opt_out, valuation=excluded.valuation,
               valuation_per_hour=excluded.valuation_per_hour, updated_at=excluded.updated_at`
        );
        const deleteSnapshotStmt = this.stmt("DELETE FROM snapshots WHERE user_id = ?");
        const streamStmt = this.stmt(
            `INSERT INTO streams (user_id, token, name, dlc, flag, since) VALUES (?, ?, ?, ?, ?, ?)
             ON CONFLICT(user_id) DO UPDATE SET token=excluded.token, name=excluded.name, dlc=excluded.dlc,
               flag=excluded.flag, since=excluded.since`
        );
        const deleteStreamStmt = this.stmt("DELETE FROM streams WHERE user_id = ?");
        const pruneHistoryStmt = this.stmt(
            "DELETE FROM history WHERE id NOT IN (SELECT id FROM history ORDER BY rowid DESC LIMIT ?)"
        );

        const tradeValues = (r: TradeRecord) => [
            r.id,
            r.type,
            r.side,
            r.resource,
            r.amount,
            r.price,
            r.from,
            r.fromUserHash,
            r.fromUserId,
            r.fillBy,
            r.filledByUserId,
            r.status,
            r.parentId ?? null,
            r.createdAt,
            r.openedAt ?? null,
            r.filledAt,
            r.closedAt,
        ];

        this.sqlite.exec("BEGIN");
        try {
            for (const userId of this.dirtyUsers) {
                const user = this.db.users[userId];
                if (!user) continue;
                userStmt.run(
                    user.userId,
                    user.tradeToken,
                    user.userName,
                    user.flag,
                    user.dlc,
                    user.authenticated ? 1 : 0,
                    user.createdAt,
                    user.lastSeenAt,
                    user.ip,
                    user.platform,
                    user.version
                );
            }
            for (const token of this.dirtyTokens) {
                const owner = this.db.tokens[token];
                if (owner !== undefined) tokenStmt.run(token, owner);
            }
            for (const token of this.deletedTokens) deleteTokenStmt.run(token);
            for (const id of this.dirtyTrades) {
                const record = this.db.trades[id];
                if (record) tradeStmt.run(...tradeValues(record));
            }
            for (const id of this.deletedTrades) deleteTradeStmt.run(id);
            for (const record of this.dirtyHistory.values()) historyStmt.run(...tradeValues(record));
            for (const id of this.deletedHistory) deleteHistoryStmt.run(id);
            for (const channel of this.dirtyChat) {
                deleteChatStmt.run(channel);
                for (const message of this.db.chat[channel] ?? []) {
                    chatStmt.run(
                        message.channel,
                        message.user,
                        message.userId,
                        message.message,
                        message.dlc,
                        message.flag,
                        message.time,
                        message.ip
                    );
                }
            }
            for (const key of this.dirtyPledges) {
                const total = this.db.pledges[key];
                if (total !== undefined) pledgeStmt.run(key, total);
            }
            for (const ip of this.dirtyMutes) {
                const until = this.db.mutes[ip];
                if (until !== undefined) muteStmt.run(ip, until);
            }
            for (const ip of this.deletedMutes) deleteMuteStmt.run(ip);
            for (const userId of this.dirtySnapshots) {
                const snapshot = this.db.snapshots[userId];
                if (!snapshot) continue;
                snapshotStmt.run(
                    snapshot.userId,
                    snapshot.userName,
                    snapshot.flag,
                    snapshot.dlc,
                    snapshot.map,
                    snapshot.mapCreatedAt,
                    snapshot.cash,
                    snapshot.resourceValuation,
                    snapshot.resourceValuationForReference,
                    snapshot.buildingValuation,
                    snapshot.buildingCount,
                    snapshot.prestigeCurrency,
                    snapshot.allPrestigeCurrency,
                    snapshot.optOut ? 1 : 0,
                    snapshot.valuation,
                    snapshot.valuationPerHour,
                    snapshot.updatedAt
                );
            }
            for (const userId of this.deletedSnapshots) deleteSnapshotStmt.run(userId);
            for (const userId of this.dirtyStreams) {
                const stream = this.db.streams[userId];
                if (!stream) continue;
                streamStmt.run(stream.userId, stream.token, stream.user.name, stream.user.dlc, stream.user.flag, stream.since);
            }
            for (const userId of this.deletedStreams) deleteStreamStmt.run(userId);
            if (this.historyPruneTo !== null) pruneHistoryStmt.run(this.historyPruneTo);
            this.sqlite.exec("COMMIT");
        } catch (e) {
            try {
                this.sqlite.exec("ROLLBACK");
            } catch {
                /* ignore */
            }
            console.error("[store] sqlite flush failed, changes stay queued:", e);
            return;
        }
        this.dirtyUsers.clear();
        this.dirtyTokens.clear();
        this.deletedTokens.clear();
        this.dirtyTrades.clear();
        this.deletedTrades.clear();
        this.dirtyHistory.clear();
        this.deletedHistory.clear();
        this.dirtyChat.clear();
        this.dirtyPledges.clear();
        this.dirtyMutes.clear();
        this.deletedMutes.clear();
        this.dirtySnapshots.clear();
        this.deletedSnapshots.clear();
        this.dirtyStreams.clear();
        this.deletedStreams.clear();
        this.historyPruneTo = null;
    }

    /** flush and close the database (server shutdown) */
    public close(): void {
        if (this.closed) return;
        this.flushSync();
        this.closed = true;
        try {
            this.sqlite.exec("PRAGMA wal_checkpoint(TRUNCATE)");
        } catch {
            /* checkpoint is best effort */
        }
        this.sqlite.close();
    }

    /**
     * Claim a trade token for a user.
     *
     * `tradeToken` ("right to trade") is generated **client side** (`PersistedData.tradeToken`)
     * and first seen by the server inside a signed trade message / verification call, so the
     * server binds it on first use. Returns false when the token already belongs to someone else.
     *
     * Tightening (audit fix): rebinding a user to a new token no longer **revokes** the
     * previous one. Self-hosted mode has no platform authentication, so a caller that only
     * knows somebody's `userId` (the `X-User-Id` header / `?user=` query are client supplied)
     * can still make the server accept an additional token — but it can no longer lock the
     * legitimate client out, because that client's existing token stays valid and its next
     * trade / verification re-adopts it. Revocation only happens through the proof-carrying
     * routes (`/trade/force-restore`, `/trade/import-save`; see `rest.ts`).
     */
    public adoptToken(userId: string, token: string): boolean {
        if (!token) return false;
        const owner = this.db.tokens[token];
        if (owner === userId) return true;
        if (owner) return false;
        const user = this.db.users[userId];
        if (!user) return false;
        // NOTE: `db.tokens[user.tradeToken]` is intentionally left in place (see the doc
        // comment): rotation must not revoke a token that the real client may still use.
        user.tradeToken = token;
        this.db.tokens[token] = userId;
        this.saveUser(user);
        this.saveToken(token, userId);
        return true;
    }

    /** whether `userId` currently owns a token registered in `db.tokens` */
    public hasBoundToken(userId: string): boolean {
        const user = this.db.users[userId];
        return !!user && !!user.tradeToken && this.db.tokens[user.tradeToken] === userId;
    }
}
