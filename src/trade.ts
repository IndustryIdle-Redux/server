/**
 * Player-to-player trade engine.
 *
 * The client (`src/features/market/PlayerTrade.ts`) drives a 4-step order lifecycle,
 * each step arriving as a `trade` message (signed by `signTrade`, carrying the user's
 * `tradeToken`):
 *
 * | status sent | meaning | preconditions | server action |
 * |---|---|---|---|
 * | `open` | place order (escrow is client side) | new id, sane numbers | add to book, broadcast `add`, reply `myTrades` |
 * | `filled` | take someone's open order | order open, not own | mark filled (`fillBy` = taker), broadcast `delete`, update maker's `myTrades` |
 * | `closed` | maker claims a filled order | owner only, status filled | settle → history, drop from `myTrades` |
 * | `cancelled` | maker cancels an open order | owner only, status open | broadcast `delete`, → history |
 *
 * Every trade message must be echoed with its `id` so the awaiting `Socket.send`
 * promise resolves (or rejects via the `error` field).
 *
 * ⚠️ Amount semantics: the client applies its own "tax" before sending a taker's
 * `filled` message, so the taker's `amount` can be lower than the open order's.
 * The server keeps the **original open amount** as the canonical executed amount —
 * that is what the taker actually paid (`acceptTrade` deducts
 * `tradeBeforeTax.amount * price` = the open amount) and therefore exactly what the
 * maker must receive on `claimTrade`.
 */

import type { ServerConfig } from "./config";
import { verifyTradeSignature } from "./hash";
import type { Store, TradeRecord, UserRecord } from "./store";
import type { ILocalTrade, ITrade, ITradeRequest, OrderSide } from "./types";
import { boundedNumber, clampString } from "./validation";

export interface TradeSink {
    /** send to every connection of one user */
    sendToUser(userId: string, message: Record<string, unknown>): void;
    /** send to every connected user (optionally skipping one) */
    broadcast(message: Record<string, unknown>, exceptUserId?: string): void;
}

const MAX_ACTIVE_TRADES_PER_USER = 20;
const MAX_TRADE_ID_LENGTH = 128;
const MAX_TRADE_NAME_LENGTH = 64;
const MAX_TRADE_VALUE = 1e30;
const TRADE_ID_PATTERN = /^[A-Za-z0-9._:-]+$/;
const RESOURCE_PATTERN = /^[A-Za-z0-9_]+$/;

export class TradeService {
    constructor(
        private readonly store: Store,
        private readonly config: ServerConfig,
        private readonly sink: TradeSink
    ) {}

    /* ---------------- wire views ---------------- */

    public toPublicTrade(t: TradeRecord): ITrade {
        return {
            id: t.id,
            from: t.from,
            fromUserHash: t.fromUserHash,
            side: t.side,
            resource: t.resource,
            amount: t.amount,
            price: t.price,
            fillBy: t.fillBy ?? null,
            status: t.status,
        };
    }

    public toLocalTrade(t: TradeRecord): ILocalTrade {
        return {
            ...this.toPublicTrade(t),
            type: "trade",
            fromUserId: t.fromUserId,
            createdAt: t.createdAt,
        };
    }

    public myTrades(userId: string): Record<string, ILocalTrade> {
        const result: Record<string, ILocalTrade> = {};
        for (const t of Object.values(this.store.db.trades)) {
            if (t.fromUserId === userId && (t.status === "open" || t.status === "filled")) {
                result[t.id] = this.toLocalTrade(t);
            }
        }
        return result;
    }

    public activeTrades(): Record<string, ITrade> {
        const result: Record<string, ITrade> = {};
        for (const t of Object.values(this.store.db.trades)) {
            if (t.status === "open") {
                result[t.id] = this.toPublicTrade(t);
            }
        }
        return result;
    }

    /* ---------------- message handling ---------------- */

    /** returns the response payload (must carry `id` when the request did) */
    public handleMessage(
        user: UserRecord,
        msg: ITradeRequest & { id?: string },
        now = Date.now()
    ): Record<string, unknown> {
        const reply = (extra: Record<string, unknown> = {}) => ({
            type: "trade",
            id: msg.id,
            myTrades: this.myTrades(user.userId),
            ...extra,
        });

        const invalid = this.validate(user, msg, now);
        if (invalid) {
            return reply({ error: invalid });
        }

        switch (msg.status) {
            case "open":
                return this.openOrder(user, msg, now) ?? reply();
            case "filled":
                return this.fillOrder(user, msg, now) ?? reply();
            case "closed":
                return this.closeOrder(user, msg, now) ?? reply();
            case "cancelled":
                return this.cancelOrder(user, msg, now) ?? reply();
            default:
                return reply({ error: `unknown status: ${msg.status}` });
        }
    }

    private validate(user: UserRecord, msg: ITradeRequest, now: number): string | null {
        if (typeof msg.token !== "string" || !msg.token || msg.token.length > 128) {
            return "invalid trade token";
        }
        if (msg.id !== undefined && (typeof msg.id !== "string" || !msg.id || msg.id.length > MAX_TRADE_ID_LENGTH || !TRADE_ID_PATTERN.test(msg.id))) {
            return "invalid id";
        }
        // Verify first: binding happens only after the message proved it came from a game
        // client, so an unsigned/garbage message cannot claim an unbound user's trade rights.
        if (!verifyTradeSignature(msg as unknown as Record<string, unknown>, this.config.saveFileKey, now)) {
            return "invalid signature";
        }
        // the trade token is generated client side: bind it on first use, but never
        // let one user present a token that already belongs to somebody else
        if (msg.token !== user.tradeToken && !this.store.adoptToken(user.userId, msg.token)) {
            return "invalid trade token";
        }
        if (msg.fromUserId && msg.fromUserId !== user.userId) {
            return "fromUserId mismatch";
        }
        return null;
    }

    /* ---------------- lifecycle ---------------- */

    private openOrder(
        user: UserRecord,
        msg: ITradeRequest & { id?: string },
        now: number
    ): Record<string, unknown> | null {
        const id = msg.id ?? (msg as { id?: string }).id;
        const error =
            typeof id !== "string" || !id
                ? "missing id"
                : this.store.db.trades[id] || this.store.db.history.some((h) => h.id === id)
                  ? "duplicate trade id"
                  : !["buy", "sell"].includes(msg.side as OrderSide)
                    ? "invalid side"
                    : !msg.resource || typeof msg.resource !== "string" || msg.resource.length > MAX_TRADE_NAME_LENGTH || !RESOURCE_PATTERN.test(msg.resource)
                      ? "invalid resource"
                      : !Number.isFinite(msg.amount) || msg.amount <= 0 || msg.amount > MAX_TRADE_VALUE
                        ? "invalid amount"
                        : !Number.isFinite(msg.price) || msg.price <= 0 || msg.price > MAX_TRADE_VALUE
                          ? "invalid price"
                          : typeof msg.fromUserHash !== "string" || msg.fromUserHash.length > MAX_TRADE_NAME_LENGTH
                            ? "invalid fromUserHash"
                            : this.countOpenOrders(user.userId) >= MAX_ACTIVE_TRADES_PER_USER
                              ? "too many open trades"
                              : null;
        if (error) {
            return { type: "trade", id, error };
        }
        const record: TradeRecord = {
            id: id as string,
            type: "trade",
            side: msg.side,
            resource: msg.resource,
            amount: msg.amount,
            price: msg.price,
            from: user.userName,
            fromUserHash: clampString(msg.fromUserHash, MAX_TRADE_NAME_LENGTH),
            fromUserId: user.userId,
            fillBy: null,
            filledByUserId: null,
            status: "open",
            createdAt: boundedNumber(msg.createdAt, 0, 8.64e15, now),
            openedAt: now,
            filledAt: null,
            closedAt: null,
        };
        this.store.db.trades[record.id] = record;
        this.store.markDirty();
        this.sink.broadcast({ type: "trade", add: { [record.id]: this.toPublicTrade(record) } });
        return null;
    }

    private fillOrder(
        user: UserRecord,
        msg: ITradeRequest & { id?: string },
        now: number
    ): Record<string, unknown> | null {
        const record = this.store.db.trades[msg.id as string];
        const error = !record
            ? "trade not found"
            : record.status !== "open"
              ? "trade is not open"
              : record.fromUserId === user.userId
                ? "cannot fill your own trade"
                : null;
        if (error) {
            return { type: "trade", id: msg.id, error };
        }
        // keep the ORIGINAL amount: it is what the taker paid for (see module doc)
        record.status = "filled";
        record.fillBy = user.userName;
        record.filledByUserId = user.userId;
        record.filledAt = now;
        this.store.markDirty();
        // the order leaves the public book; the maker now has a claimable trade
        this.sink.broadcast({ type: "trade", delete: { [record.id]: {} } });
        this.sink.sendToUser(record.fromUserId, { type: "trade", myTrades: this.myTrades(record.fromUserId) });
        return null;
    }

    private closeOrder(
        user: UserRecord,
        msg: ITradeRequest & { id?: string },
        now: number
    ): Record<string, unknown> | null {
        const record = this.store.db.trades[msg.id as string];
        const error = !record
            ? "trade not found"
            : record.fromUserId !== user.userId
              ? "not your trade"
              : record.status !== "filled"
                ? "trade is not filled"
                : null;
        if (error) {
            return { type: "trade", id: msg.id, error };
        }
        record.status = "closed";
        record.closedAt = now;
        this.settle(record);
        return null;
    }

    private cancelOrder(
        user: UserRecord,
        msg: ITradeRequest & { id?: string },
        now: number
    ): Record<string, unknown> | null {
        const record = this.store.db.trades[msg.id as string];
        const error = !record
            ? "trade not found"
            : record.fromUserId !== user.userId
              ? "not your trade"
              : record.status !== "open"
                ? "trade is not open"
                : null;
        if (error) {
            return { type: "trade", id: msg.id, error };
        }
        record.status = "cancelled";
        record.closedAt = now;
        this.settle(record);
        this.sink.broadcast({ type: "trade", delete: { [record.id]: {} } });
        return null;
    }

    /** move a finished order out of the live tables into history */
    private settle(record: TradeRecord): void {
        delete this.store.db.trades[record.id];
        this.store.db.history.push({ ...record, closedAt: record.closedAt ?? Date.now() });
        // keep history bounded
        if (this.store.db.history.length > 50_000) {
            this.store.db.history.splice(0, this.store.db.history.length - 50_000);
        }
        this.store.markDirty();
        this.sink.sendToUser(record.fromUserId, { type: "trade", myTrades: this.myTrades(record.fromUserId) });
    }

    /* ---------------- admin / maintenance ---------------- */

    /**
     * Expire open orders older than `config.staleTradeTtlMs` (0 = disabled).
     *
     * Swept orders are cancelled exactly like a client `cancelled` message: the status
     * becomes `cancelled`, the order moves to history and a `delete` is broadcast, so the
     * client removes it from the public book and from `myTrades` (`settle` pushes the
     * owner's new `myTrades`). Returns the number of swept orders.
     *
     * ⚠️ The client only refunds escrowed resources when **it** sends the cancel
     * (`PlayerTrade.cancelTrade`); a server-side sweep therefore strands the escrow. That
     * is why the TTL defaults to 0 and enabling it is an explicit operator choice.
     *
     * `openedAt` is the server receive time, so a client cannot dodge the sweep (neither
     * trigger it early) by forging the wire `createdAt`.
     */
    public sweepStale(now = Date.now()): number {
        const ttl = this.config.staleTradeTtlMs;
        if (!ttl || ttl <= 0) return 0;
        let count = 0;
        // Object.values snapshots the live table, so `settle` may delete from it while sweeping
        for (const record of Object.values(this.store.db.trades)) {
            if (record.status !== "open") continue;
            if (now - (record.openedAt ?? record.createdAt) < ttl) continue;
            record.status = "cancelled";
            record.closedAt = now;
            this.settle(record);
            this.sink.broadcast({ type: "trade", delete: { [record.id]: {} } });
            count++;
        }
        return count;
    }

    /** POST /trade/remove?id= — moderator removes any live order */
    public removeTrade(id: string): boolean {
        const record = this.store.db.trades[id];
        if (!record) return false;
        record.status = "cancelled";
        record.closedAt = Date.now();
        this.settle(record);
        this.sink.broadcast({ type: "trade", delete: { [id]: {} } });
        return true;
    }

    /** POST /trade/clear — drop every live order of a user (used on save import / reset) */
    public clearTrades(userId: string): number {
        let count = 0;
        for (const record of Object.values(this.store.db.trades)) {
            if (record.fromUserId === userId) {
                record.status = "cancelled";
                record.closedAt = Date.now();
                this.settle(record);
                this.sink.broadcast({ type: "trade", delete: { [record.id]: {} } });
                count++;
            }
        }
        return count;
    }

    public history(userId: string): (ILocalTrade & { timestamp: number })[] {
        return this.store.db.history
            .filter((h) => h.fromUserId === userId)
            .map((h) => ({ ...this.toLocalTrade(h), timestamp: h.closedAt ?? h.createdAt }));
    }

    private countOpenOrders(userId: string): number {
        return Object.values(this.store.db.trades).filter((t) => t.fromUserId === userId && t.status === "open").length;
    }
}
