/**
 * End-to-end protocol tests: real HTTP + WebSocket server, speaking the exact
 * wire protocol of `src/net/Socket.ts` (including `signTrade` signatures).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { startTestServer, TestClient, tradeMessage, signTrade } from "./helpers";
import type { RunningServer } from "../src/server";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

let running: RunningServer;
let port: number;
let http: string;

beforeAll(async () => {
    // explicit, minimal mod list: `mods: []` (the production default) would make the ip
    // visibility / mute assertions impossible, and `["*"]` is exactly the dangerous
    // opt-in this suite must not normalise.
    const started = await startTestServer({ mods: ["alice", "bob"] });
    running = started.running;
    port = started.port;
    http = started.http;
});

afterAll(async () => {
    await running.close();
});

async function rest(path: string, init: RequestInit = {}, userId = "alice") {
    return fetch(`${http}${path}`, {
        ...init,
        headers: { "X-User-Id": userId, ...(init.headers ?? {}) },
    });
}

describe("websocket handshake & join", () => {
    it("rejects connections without a user", async () => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`);
        const err = await new Promise<string>((resolve) => ws.on("close", (code) => resolve(String(code))));
        expect(err).toBe("4001");
    });

    it("answers join with chat history, market state, pledges and streamers", async () => {
        const client = await TestClient.connect(port, "alice");
        client.send({ type: "join", channel: "en", streaming: false });
        const join = await client.waitType("join");
        expect(Array.isArray(join.messages)).toBe(true);
        const trade = await client.waitType("trade");
        expect(trade.flush).toBeDefined();
        expect(trade.myTrades).toBeDefined();
        const pledge = await client.waitType("pledge");
        expect(pledge.pledge).toBeDefined();
        const streaming = await client.waitType("streaming");
        expect(streaming.users).toBeDefined();
        // every message carries the server clock + mod flag (the client resets isMod otherwise)
        for (const m of client.received) {
            expect(typeof m.time).toBe("number");
            expect(typeof m.isMod).toBe("boolean");
        }
        client.close();
    });
});

describe("chat", () => {
    it("delivers messages to the channel, with ip only for mods", async () => {
        const alice = await TestClient.connect(port, "alice");
        const bob = await TestClient.connect(port, "bob");
        alice.send({ type: "join", channel: "en" });
        bob.send({ type: "join", channel: "en" });
        await alice.waitType("join");
        await bob.waitType("join");
        alice.send({ type: "chat", user: "AliceCustom", dlc: 2, flag: "de", message: "hello bob", channel: "en" });

        const seen = await bob.waitType("chat", (m) => m.message === "hello bob");
        // the display name / flag / dlc come from the chat message (changeable in-game),
        // not from the (stale) user record
        expect(seen.user).toBe("AliceCustom");
        expect(seen.flag).toBe("de");
        expect(seen.dlc).toBe(2);
        expect(seen.channel).toBe("en");
        expect(seen.ip).toBeDefined(); // bob is an explicit mod in this suite

        // history is replayed on join
        const carol = await TestClient.connect(port, "carol");
        carol.send({ type: "join", channel: "en" });
        const join = await carol.waitType("join");
        expect(join.messages.some((m: any) => m.message === "hello bob")).toBe(true);
        alice.close();
        bob.close();
        carol.close();
    });

    it("keeps channels separate", async () => {
        const alice = await TestClient.connect(port, "alice");
        const bob = await TestClient.connect(port, "bob");
        alice.send({ type: "join", channel: "zh" });
        bob.send({ type: "join", channel: "de" });
        await alice.waitType("join");
        await bob.waitType("join");
        alice.send({ type: "chat", user: "ALICE", dlc: 0, flag: "de", message: "私密", channel: "zh" });
        await new Promise((r) => setTimeout(r, 150));
        expect(bob.received.some((m) => m.type === "chat")).toBe(false);
        alice.close();
        bob.close();
    });
});

describe("trades over the wire", () => {
    it("full lifecycle: open → fill → claim, mirrored to both clients", async () => {
        const alice = await TestClient.connect(port, "alice");
        const bob = await TestClient.connect(port, "bob");
        alice.send({ type: "join", channel: "en" });
        bob.send({ type: "join", channel: "en" });
        await alice.waitType("trade");
        await bob.waitType("trade");
        const before = alice.received.length;

        // alice opens a sell order (signed like `PlayerTrade.addTrade`)
        const open = tradeMessage("alice", {
            id: "trade-1",
            side: "sell",
            resource: "Fe",
            amount: 100,
            price: 7,
            token: "alice-wire-token",
        });
        const openReply = await alice.request(open);
        expect(openReply.error).toBeUndefined();
        expect(openReply.myTrades["trade-1"].status).toBe("open");

        // bob sees it in the book
        const added = await bob.waitType("trade", (m) => m.add && m.add["trade-1"]);
        expect(added.add["trade-1"].price).toBe(7);

        // bob fills it (his tax-reduced amount must NOT become canonical)
        const fill = tradeMessage("bob", {
            id: "trade-1",
            side: "sell",
            resource: "Fe",
            amount: 95,
            price: 7,
            token: "bob-wire-token",
            status: "filled",
            fillBy: "BOB",
            fromUserId: undefined as never,
        });
        delete fill.fromUserId;
        const fillReply = await bob.request(fill);
        expect(fillReply.error).toBeUndefined();

        const removed = await bob.waitType("trade", (m) => m.delete && m.delete["trade-1"]);
        expect(removed.delete["trade-1"]).toBeDefined();
        const claimable = await alice.waitType("trade", (m) => m.myTrades && m.myTrades["trade-1"]?.status === "filled");
        expect(claimable.myTrades["trade-1"].amount).toBe(100); // original amount kept
        expect(claimable.myTrades["trade-1"].fillBy).toBe("BOB");

        // alice claims
        const claim = signTrade({ ...claimable.myTrades["trade-1"], status: "closed", token: "alice-wire-token" });
        const claimReply = await alice.request({ ...claim, id: "trade-1" } as never);
        expect(claimReply.error).toBeUndefined();
        expect(Object.keys(claimReply.myTrades)).toHaveLength(0);

        const history = await (await rest("/trade/history", {}, "alice")).json();
        expect(history).toHaveLength(1);
        expect(history[0].fillBy).toBe("BOB");
        expect(history[0].timestamp).toBeGreaterThan(0);
        void before;
        alice.close();
        bob.close();
    });

    it("rejects tampered / wrongly signed trades", async () => {
        const alice = await TestClient.connect(port, "alice");
        alice.send({ type: "join", channel: "en" });
        await alice.waitType("trade");
        const msg = tradeMessage("alice", { id: "evil-1", side: "sell", resource: "Fe", amount: 1, price: 1, token: "alice-wire-token" });
        (msg as any).price = 0.0001; // tamper after signing
        const reply = await alice.request(msg as never);
        expect(reply.error).toBe("invalid signature");
        alice.close();
    });
});

describe("tick → leaderboard", () => {
    it("ingests ticks and serves every board shape", async () => {
        const alice = await TestClient.connect(port, "alice");
        alice.send({ type: "join", channel: "en" });
        await alice.waitType("join");
        alice.send({
            type: "tick",
            userName: "ALICE",
            flag: "de",
            dlc: 2,
            map: "Oslo",
            mapCreatedAt: Date.now() - 1000,
            cash: 123456,
            resourceValuation: 1000,
            resourceValuationForReference: 1000,
            buildingValuation: 500,
            buildingCount: 20,
            prestigeCurrency: 3,
            allPrestigeCurrency: 30,
            optOut: false,
        });
        // ticks are answered with a heartbeat (the client reconnects without one)
        await alice.waitType("streaming", (m) => m.users !== undefined);

        const board = await (await rest("/leaderboard/v4?name=byCash")).json();
        const row = board.data.find((r: any[]) => r[1] === "ALICE");
        expect(row).toBeDefined();
        expect(row[0]).toBe(123456);
        expect(row[2]).toBe(2); // dlc → Exp image
        expect(row[3]).toBe("de");
        expect(row[4]).toBe("Oslo");
        expect(board.updatedAt).toBeGreaterThan(0);

        const byMap = await (await rest("/leaderboard/v4?name=byMap")).json();
        expect(byMap.data.some((r: any[]) => r[0] === "Oslo")).toBe(true);
        alice.close();
    });

    it("excludes leaderboard opt-outs", async () => {
        const ghost = await TestClient.connect(port, "ghost");
        ghost.send({ type: "join", channel: "en" });
        await ghost.waitType("join");
        ghost.send({ type: "tick", userName: "GHOST", cash: 9e9, resourceValuation: 0, buildingValuation: 0, optOut: true, map: "Oslo", mapCreatedAt: Date.now(), flag: "xx", dlc: 0, buildingCount: 1, prestigeCurrency: 0, allPrestigeCurrency: 0, resourceValuationForReference: 0 });
        await ghost.waitType("streaming", (m) => m.users !== undefined);
        const board = await (await rest("/leaderboard/v4?name=byCash")).json();
        expect(board.data.some((r: any[]) => r[1] === "GHOST")).toBe(false);
        ghost.close();
    });
});

describe("leaderboard cache", () => {
    it("reuses the response inside the cache window", async () => {
        const server = await startTestServer({ leaderboardCacheMs: 60_000 });
        const client = await TestClient.connect(server.port, "cache-user");
        client.send({
            type: "tick",
            userName: "CACHE",
            flag: "earth",
            dlc: 0,
            map: "Stockholm",
            cash: 123,
            resourceValuation: 1,
            buildingValuation: 1,
            buildingCount: 1,
            prestigeCurrency: 0,
            allPrestigeCurrency: 0,
        });
        await sleep(200);
        const first = await (await fetch(`${server.http}/leaderboard/v4?name=byCash`)).json();
        await sleep(30);
        const second = await (await fetch(`${server.http}/leaderboard/v4?name=byCash`)).json();
        expect(first.updatedAt).toBe(second.updatedAt);
        client.close();
        await server.running.close();
    });
});

describe("crowdfunding pledges", () => {
    it("aggregates pledges per project + slot", async () => {
        const alice = await TestClient.connect(port, "alice");
        const bob = await TestClient.connect(port, "bob");
        for (const c of [alice, bob]) {
            c.send({ type: "join", channel: "en" });
            await c.waitType("pledge");
        }
        const msgId = "pledge-req-1";
        const replyPromise = alice.wait((m) => m.type === "pledge" && m.id === msgId);
        alice.send({ type: "pledge", id: msgId, pledge: { "1700000": [{ resource: "Fe", index: 0, amount: 50 }] } });
        const reply = await replyPromise;
        expect(reply.pledge["1700000.0"]).toBeGreaterThanOrEqual(50);

        const reply2 = await bob.request({
            id: "pledge-req-2",
            type: "pledge",
            pledge: { "1700000": [{ resource: "Fe", index: 0, amount: 30 }] },
        });
        expect(reply2.pledge["1700000.0"]).toBeGreaterThanOrEqual(80);
        alice.close();
        bob.close();
    });
});

describe("REST endpoints", () => {
    it("verification reports a valid right to trade", async () => {
        const r = await rest("/user/verification?tradeToken=alice-wire-token", { method: "post" });
        expect(r.status).toBe(200);
        const json = await r.json();
        expect(json).toMatchObject({ authenticated: true, rightToTrade: true, passAntiCheat: true, passPlatformIdCheck: true });
    });

    it("import-save binds a first token for a user that has none yet", async () => {
        // NOTE: the old test reused "alice" after she had already bound a token, which is
        // exactly the unauthenticated rotation this fix removes. A user with no bound
        // token is still allowed to import (see test/security.test.ts for the denial case).
        const r = await rest("/trade/import-save?token=imported-token", { method: "post" }, "fresh-importer");
        expect(r.status).toBe(200);
        const json = await r.json();
        expect(typeof json.token).toBe("string");
        expect(json.token).not.toBe("imported-token");
    });

    it("stream on/off updates the discoverable list", async () => {
        const on = await (await rest("/stream?status=on", { method: "post" }, "streamer")).json();
        expect(on.streaming).toBe(true);
        expect(typeof on.token).toBe("string");
        const client = await TestClient.connect(port, "viewer");
        client.send({ type: "join", channel: "en" });
        const streaming = await client.waitType("streaming", (m) => Object.keys(m.users ?? {}).length > 0);
        expect(streaming.users[on.token].name).toBeDefined();

        const off = await (await rest("/stream?status=off", { method: "post" }, "streamer")).json();
        expect(off.streaming).toBe(false);
        client.close();
    });

    it("mutes an ip for chat", async () => {
        const r = await rest(`/chat/mute?ip=127.0.0.1&time=60000`, { method: "post" });
        expect(r.status).toBe(200);
        const muted = await TestClient.connect(port, "muted");
        muted.send({ type: "join", channel: "en" });
        await muted.waitType("join");
        const before = muted.received.filter((m) => m.type === "chat").length;
        muted.send({ type: "chat", user: "MUTED", dlc: 0, flag: "xx", message: "should be dropped", channel: "en" });
        await new Promise((r2) => setTimeout(r2, 150));
        expect(muted.received.filter((m) => m.type === "chat").length).toBe(before);
        await rest(`/chat/mute?ip=127.0.0.1&time=0`, { method: "post" });
        muted.close();
    });

    it("trade/clear drops live orders", async () => {
        const alice = await TestClient.connect(port, "alice");
        alice.send({ type: "join", channel: "en" });
        await alice.waitType("trade");
        const open = tradeMessage("alice", { id: "clear-me", side: "buy", resource: "Coal", amount: 5, price: 2, token: "alice-wire-token" });
        await alice.request(open);
        const r = await rest("/trade/clear", { method: "post" });
        expect(r.status).toBe(200);
        const history = await (await rest("/trade/history", {}, "alice")).json();
        expect(history.some((h: any) => h.id === "clear-me")).toBe(true);
        alice.close();
    });

    it("health check responds", async () => {
        const r = await fetch(`${http}/health`);
        expect((await r.json()).ok).toBe(true);
    });

    it("sends CORS headers for cross-origin game clients", async () => {
        const r = await fetch(`${http}/leaderboard/v4?name=byCash`);
        expect(r.headers.get("access-control-allow-origin")).toBe("*");
        const pre = await fetch(`${http}/trade/history`, {
            method: "OPTIONS",
            headers: { "Access-Control-Request-Method": "GET", Origin: "http://localhost:5180" },
        });
        expect(pre.status).toBe(204);
    });
});
