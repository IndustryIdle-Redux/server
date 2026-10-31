/**
 * Persistence layer — a single JSON document (`data/db.json`) with debounced,
 * atomic (write-to-temp + rename) saves. Small player counts are assumed, so the
 * whole database lives in memory and is flushed to disk.
 */

import fs from "node:fs";
import path from "node:path";
import type { IStreamingUser } from "./types";

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

export class Store {
    public db: Db = emptyDb();
    private readonly file: string;
    private saveTimer: NodeJS.Timeout | null = null;

    constructor(dataDir: string) {
        fs.mkdirSync(dataDir, { recursive: true });
        this.file = path.join(dataDir, "db.json");
        this.load();
    }

    private load(): void {
        if (!fs.existsSync(this.file)) return;
        try {
            const parsed = JSON.parse(fs.readFileSync(this.file, "utf8"));
            this.db = { ...emptyDb(), ...parsed };
        } catch (e) {
            console.error("[store] failed to load db.json, starting empty:", e);
            this.db = emptyDb();
        }
    }

    /** schedule a debounced flush */
    public markDirty(): void {
        if (this.saveTimer) return;
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            this.flushSync();
        }, 500);
        // do not keep the process alive just for a pending save
        this.saveTimer.unref?.();
    }

    public flushSync(): void {
        if (this.saveTimer) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
        }
        const tmp = this.file + ".tmp";
        fs.writeFileSync(tmp, JSON.stringify(this.db));
        fs.renameSync(tmp, this.file);
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
        this.markDirty();
        return true;
    }

    /** whether `userId` currently owns a token registered in `db.tokens` */
    public hasBoundToken(userId: string): boolean {
        const user = this.db.users[userId];
        return !!user && !!user.tradeToken && this.db.tokens[user.tradeToken] === userId;
    }
}
