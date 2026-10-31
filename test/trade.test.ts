/** Trade lifecycle unit tests (order book semantics, see `src/trade.ts`). */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { TradeService } from "../src/trade";
import { Store, type UserRecord } from "../src/store";
import { signTrade, SAVE_KEY, tradeMessage } from "./helpers";

function makeService(overrides: Record<string, unknown> = {}) {
    const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "ii-trade-test-")));
    const sent: { userId: string; message: Record<string, unknown> }[] = [];
    const broadcasts: Record<string, unknown>[] = [];
    const sink = {
        sendToUser: (userId: string, message: Record<string, unknown>) => sent.push({ userId, message }),
        broadcast: (message: Record<string, unknown>) => broadcasts.push(message),
    };
    const service = new TradeService(store, { saveFileKey: SAVE_KEY, staleTradeTtlMs: 0, ...overrides } as never, sink);
    return { store, service, sent, broadcasts };
}

function makeUser(store: Store, userId: string, token: string): UserRecord {
    const user: UserRecord = {
        userId,
        tradeToken: token,
        userName: userId.toUpperCase(),
        flag: "earth",
        dlc: 0,
        authenticated: true,
        createdAt: Date.now(),
        lastSeenAt: Date.now(),
        ip: "127.0.0.1",
        platform: "web",
        version: "test",
    };
    store.db.users[userId] = user;
    store.db.tokens[token] = userId;
    return user;
}

describe("TradeService", () => {
    let ctx: ReturnType<typeof makeService>;
    let alice: UserRecord;
    let bob: UserRecord;

    beforeEach(() => {
        ctx = makeService();
        alice = makeUser(ctx.store, "alice", "alice-token");
        bob = makeUser(ctx.store, "bob", "bob-token");
    });

    function open(user: UserRecord, over: Record<string, unknown> = {}) {
        return ctx.service.handleMessage(user, tradeMessage(user.userId, { id: "o1", side: "sell", resource: "Fe", amount: 100, price: 5, token: user.tradeToken, ...over }) as never);
    }

    it("opens an order, broadcasts it and shows it in myTrades", () => {
        const reply = open(alice);
        expect(reply.error).toBeUndefined();
        expect((reply.myTrades as any).o1.amount).toBe(100);
        expect((reply.myTrades as any).o1.status).toBe("open");
        expect(ctx.store.db.trades.o1.status).toBe("open");
        expect(ctx.service.activeTrades().o1.amount).toBe(100);
        expect(ctx.broadcasts.some((b) => (b.add as any)?.o1)).toBe(true);
    });

    it("does not bind a trade token before the signature is verified", () => {
        const carol: UserRecord = {
            userId: "carol",
            tradeToken: "",
            userName: "CAROL",
            flag: "earth",
            dlc: 0,
            authenticated: true,
            createdAt: Date.now(),
            lastSeenAt: Date.now(),
            ip: "127.0.0.1",
            platform: "web",
            version: "test",
        };
        ctx.store.db.users.carol = carol;
        const msg = tradeMessage("carol", { id: "c1", side: "sell", resource: "Fe", amount: 1, price: 1, token: "stolen-token" });
        msg.sig = "0"; // tampered after signing
        const reply = ctx.service.handleMessage(carol, msg as never);
        expect(reply.error).toBe("invalid signature");
        expect(carol.tradeToken).toBe("");
        expect(ctx.store.db.tokens["stolen-token"]).toBeUndefined();
        expect(ctx.store.hasBoundToken("carol")).toBe(false);
    });

    it("rejects oversized trade fields", () => {
        expect(open(alice, { id: "x".repeat(200) }).error).toBe("invalid id");
        expect(open(alice, { resource: "Fe".repeat(100) }).error).toBe("invalid resource");
        expect(open(alice, { amount: 1e40 }).error).toBe("invalid amount");
        expect(open(alice, { price: 1e40 }).error).toBe("invalid price");
        expect(open(alice, { fromUserHash: "h".repeat(200) }).error).toBe("invalid fromUserHash");
    });

    it("rejects duplicate ids", () => {
        open(alice);
        const reply = open(alice);
        expect(reply.error).toBe("duplicate trade id");
    });

    it("rejects bad numbers / sides", () => {
        expect(open(alice, { amount: -5 }).error).toBe("invalid amount");
        expect(open(alice, { price: 0 }).error).toBe("invalid price");
        expect(open(alice, { side: "hold" }).error).toBe("invalid side");
        expect(open(alice, { resource: "" }).error).toBe("invalid resource");
    });

    it("rejects a trade signed with the wrong key or tampered", () => {
        const msg = tradeMessage("alice", { id: "o2", side: "sell", resource: "Fe", amount: 1, price: 1, token: "alice-token" });
        (msg as any).amount = 999999; // tamper after signing
        const reply = ctx.service.handleMessage(alice, msg as never);
        expect(reply.error).toBe("invalid signature");
    });

    it("rejects a token that belongs to another user", () => {
        const msg = tradeMessage("alice", { id: "o3", side: "sell", resource: "Fe", amount: 1, price: 1, token: "bob-token" });
        const reply = ctx.service.handleMessage(alice, msg as never);
        expect(reply.error).toBe("invalid trade token");
    });

    it("adopts a fresh client-side token on first use", () => {
        const msg = tradeMessage("alice", { id: "o4", side: "sell", resource: "Fe", amount: 1, price: 1, token: "brand-new-token" });
        const reply = ctx.service.handleMessage(alice, msg as never);
        expect(reply.error).toBeUndefined();
        expect(alice.tradeToken).toBe("brand-new-token");
    });

    it("fills an order keeping the ORIGINAL amount (the taker's tax is client side)", () => {
        open(alice);
        const fill = tradeMessage("bob", {
            id: "o1",
            side: "sell",
            resource: "Fe",
            amount: 90, // taker's tax-reduced amount — must NOT become canonical
            price: 5,
            token: "bob-token",
            status: "filled",
            fillBy: "BOB",
        });
        const reply = ctx.service.handleMessage(bob, fill as never);
        expect(reply.error).toBeUndefined();
        expect(ctx.store.db.trades.o1.status).toBe("filled");
        expect(ctx.store.db.trades.o1.amount).toBe(100);
        expect(ctx.store.db.trades.o1.fillBy).toBe("BOB");
        expect(ctx.service.activeTrades().o1).toBeUndefined();
        expect(ctx.broadcasts.some((b) => (b.delete as any)?.o1)).toBe(true);
        // the maker gets the updated claimable trade
        const toAlice = ctx.sent.filter((s) => s.userId === "alice").pop()!;
        expect((toAlice.message.myTrades as any).o1.status).toBe("filled");
    });

    it("rejects self-fill and double-fill", () => {
        open(alice);
        const selfFill = tradeMessage("alice", { id: "o1", side: "sell", resource: "Fe", amount: 100, price: 5, token: "alice-token", status: "filled", fillBy: "ALICE" });
        expect(ctx.service.handleMessage(alice, selfFill as never).error).toBe("cannot fill your own trade");
        const fill = tradeMessage("bob", { id: "o1", side: "sell", resource: "Fe", amount: 100, price: 5, token: "bob-token", status: "filled", fillBy: "BOB" });
        ctx.service.handleMessage(bob, fill as never);
        expect(ctx.service.handleMessage(bob, fill as never).error).toBe("trade is not open");
    });

    it("claims (close) settle to history and clear myTrades", () => {
        open(alice);
        const fill = tradeMessage("bob", { id: "o1", side: "sell", resource: "Fe", amount: 100, price: 5, token: "bob-token", status: "filled", fillBy: "BOB" });
        ctx.service.handleMessage(bob, fill as never);
        const close = signTrade({ ...ctx.service.myTrades("alice").o1, status: "closed", token: "alice-token" });
        const reply = ctx.service.handleMessage(alice, close as never);
        expect(reply.error).toBeUndefined();
        expect(Object.keys(reply.myTrades as object)).toHaveLength(0);
        const history = ctx.service.history("alice");
        expect(history).toHaveLength(1);
        expect(history[0].status).toBe("closed");
        expect(history[0].fillBy).toBe("BOB");
        expect(history[0].timestamp).toBeGreaterThan(0);
    });

    it("only the owner may claim", () => {
        open(alice);
        const fill = tradeMessage("bob", { id: "o1", side: "sell", resource: "Fe", amount: 100, price: 5, token: "bob-token", status: "filled", fillBy: "BOB" });
        ctx.service.handleMessage(bob, fill as never);
        const close = signTrade({ ...ctx.service.myTrades("alice").o1, status: "closed", token: "bob-token", fromUserId: "bob" });
        expect(ctx.service.handleMessage(bob, close as never).error).toBe("not your trade");
    });

    it("cancels open orders and records them in history", () => {
        open(alice);
        const cancel = signTrade({ ...ctx.service.myTrades("alice").o1, status: "cancelled", token: "alice-token" });
        const reply = ctx.service.handleMessage(alice, cancel as never);
        expect(reply.error).toBeUndefined();
        expect(ctx.service.activeTrades().o1).toBeUndefined();
        expect(ctx.service.history("alice")[0].status).toBe("cancelled");
    });

    it("cannot cancel someone else's or a filled order", () => {
        open(alice);
        const cancel = signTrade({ ...ctx.service.myTrades("alice").o1, status: "cancelled", token: "bob-token", fromUserId: "bob" });
        expect(ctx.service.handleMessage(bob, cancel as never).error).toBe("not your trade");
    });

    it("clearTrades drops every live order of a user", () => {
        open(alice, { id: "a1" });
        open(alice, { id: "a2" });
        expect(ctx.service.clearTrades("alice")).toBe(2);
        expect(Object.keys(ctx.service.activeTrades())).toHaveLength(0);
    });

    it("trade messages can carry no correlation id (fire-and-forget)", () => {
        // built without `id` from the start (JSON would drop undefined keys and break the signature)
        const msg = signTrade({ type: "trade", side: "sell", resource: "Fe", amount: 1, price: 1, token: "alice-token", status: "open" });
        const reply = ctx.service.handleMessage(alice, msg as never);
        expect(reply.error).toBe("missing id");
    });
});

describe("stale order reaping", () => {
    function withTtl(ttl: number) {
        const ctx = makeService({ staleTradeTtlMs: ttl });
        const alice = makeUser(ctx.store, "alice", "alice-token");
        return { ctx, alice };
    }

    it("cancels orders older than the TTL, broadcasts delete and moves them to history", () => {
        const { ctx, alice } = withTtl(1000);
        const t0 = Date.now();
        const opened = ctx.service.handleMessage(
            alice,
            tradeMessage("alice", { id: "old-1", side: "sell", resource: "Fe", amount: 5, price: 2, token: "alice-token" }) as never,
            t0
        );
        expect(opened.error).toBeUndefined();
        expect(ctx.service.activeTrades()["old-1"]).toBeDefined();

        expect(ctx.service.sweepStale(t0 + 999)).toBe(0); // still fresh
        expect(ctx.service.sweepStale(t0 + 1000)).toBe(1);
        expect(ctx.service.activeTrades()["old-1"]).toBeUndefined();
        expect(ctx.store.db.trades["old-1"]).toBeUndefined();
        const history = ctx.store.db.history.find((h) => h.id === "old-1");
        expect(history?.status).toBe("cancelled");
        expect(ctx.broadcasts.some((b) => (b.delete as any)?.["old-1"])).toBe(true);
        // the owner gets the refreshed myTrades (their order disappeared)
        const toAlice = ctx.sent.filter((s) => s.userId === "alice").pop()!;
        expect((toAlice.message.myTrades as any)["old-1"]).toBeUndefined();
    });

    it("does nothing when the TTL is 0 (disabled)", () => {
        const { ctx, alice } = withTtl(0);
        const t0 = Date.now();
        ctx.service.handleMessage(
            alice,
            tradeMessage("alice", { id: "keep-1", side: "buy", resource: "Fe", amount: 5, price: 2, token: "alice-token" }) as never,
            t0
        );
        expect(ctx.service.sweepStale(t0 + 10 * 60_000)).toBe(0);
        expect(ctx.service.activeTrades()["keep-1"]).toBeDefined();
    });

    it("uses the server receive time, not the client-supplied createdAt", () => {
        const { ctx, alice } = withTtl(1000);
        const t0 = Date.now();
        // forged createdAt far in the past must not make the order instantly stale
        ctx.service.handleMessage(
            alice,
            tradeMessage("alice", { id: "forged-1", side: "sell", resource: "Fe", amount: 1, price: 1, token: "alice-token", createdAt: 0 }) as never,
            t0
        );
        expect(ctx.store.db.trades["forged-1"].openedAt).toBe(t0);
        expect(ctx.service.sweepStale(t0 + 500)).toBe(0);
        expect(ctx.service.sweepStale(t0 + 1000)).toBe(1);
    });
});
