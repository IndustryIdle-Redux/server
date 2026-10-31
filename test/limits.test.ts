import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import WebSocket from "ws";
import { startTestServer, TestClient } from "./helpers";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function closeInfo(client: TestClient, timeoutMs = 3000): Promise<{ code: number; reason: string }> {
    const timeout = new Promise<{ code: number; reason: string }>((_, reject) =>
        setTimeout(() => reject(new Error("socket was not closed")), timeoutMs)
    );
    return Promise.race([client.closed, timeout]);
}

describe("WebSocket input limits", () => {
    it("caps long tick fields before they reach the leaderboard", async () => {
        const server = await startTestServer();
        const client = await TestClient.connect(server.port, "long-name-user");
        client.send({ type: "join", channel: "en" });
        client.send({
            type: "tick",
            userName: "N".repeat(5000),
            flag: "F".repeat(5000),
            map: "M".repeat(5000),
            cash: 10,
            resourceValuation: 1,
            buildingValuation: 1,
            buildingCount: 1,
            prestigeCurrency: 0,
            allPrestigeCurrency: 0,
        });
        await sleep(300);
        const row = await (await fetch(`${server.http}/leaderboard/v4?name=byCash`)).json();
        expect(row.data[0][1].length).toBe(64);
        expect((row.data[0][3] as string).length).toBe(64);
        const snapshot = server.running.store.db.snapshots["long-name-user"];
        expect(snapshot?.userName.length).toBe(64);
        client.close();
        await server.running.close();
    });

    it("falls back to the default channel for an oversized chat channel", async () => {
        const server = await startTestServer();
        const client = await TestClient.connect(server.port, "channel-user");
        client.send({ type: "chat", user: "C", flag: "earth", dlc: 0, message: "hi", channel: "C".repeat(4096) });
        await sleep(300);
        expect(Object.keys(server.running.store.db.chat)).not.toContain("C".repeat(4096));
        expect(Object.keys(server.running.store.db.chat)).toContain("en");
        client.close();
        await server.running.close();
    });

    it("bounds pledge entries", async () => {
        const server = await startTestServer();
        const client = await TestClient.connect(server.port, "pledge-user");
        client.send({
            type: "pledge",
            id: "p1",
            pledge: { ["P".repeat(5000)]: [{ resource: "x", index: 0, amount: 1e40 }] },
        });
        await sleep(200);
        expect(Object.keys(server.running.store.db.pledges).length).toBe(0);
        client.close();
        await server.running.close();
    });

    it("closes a connection that exceeds the message rate", async () => {
        const server = await startTestServer({ wsRateLimitPerSecond: 5 });
        const client = await TestClient.connect(server.port, "spammy");
        for (let i = 0; i < 40; i++) client.send({ type: "tick", userName: "x", cash: i });
        const info = await closeInfo(client);
        expect(info.code).toBe(1008);
        await server.running.close();
    });

    it("enforces the WebSocket payload cap", async () => {
        const server = await startTestServer({ maxWsPayloadBytes: 1024 });
        const client = await TestClient.connect(server.port, "big-message");
        client.send({ type: "tick", userName: "x".repeat(4000) });
        const info = await closeInfo(client);
        expect(info.code).toBe(1009);
        await server.running.close();
    });

    it("applies the export quota and keeps uploads unique", async () => {
        const server = await startTestServer({ exportMinIntervalMs: 60_000 });
        const client = await TestClient.connect(server.port, "export-user");
        for (let i = 0; i < 3; i++) client.send({ type: "export", data: { blob: "x".repeat(1000) } });
        await sleep(600);
        const dir = path.join(server.config.dataDir, "saves");
        const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
        expect(files.length).toBe(1);
        client.close();
        await server.running.close();
    });

    it("caps concurrent WebRTC sessions per user", async () => {
        const server = await startTestServer();
        const streamer = await TestClient.connect(server.port, "streamer");
        const view = await TestClient.connect(server.port, "viewer");
        const res = await fetch(`${server.http}/stream?status=on`, { method: "POST", headers: { "X-User-Id": "streamer" } });
        const { token } = (await res.json()) as { token: string };
        for (let i = 0; i < 50; i++) view.send({ type: "signal", init: true, token, user: { name: "v" } });
        await sleep(500);
        const inits = streamer.received.filter((m) => m.type === "signal" && m.init).length;
        expect(inits).toBeLessThanOrEqual(32);
        expect(inits).toBeGreaterThan(0);
        streamer.close();
        view.close();
        await server.running.close();
    });
});

describe("data growth caps", () => {
    it("refuses new users above maxUsers", async () => {
        const server = await startTestServer({ maxUsers: 1 });
        const first = await TestClient.connect(server.port, "first-user");
        const second = new WebSocket(`ws://127.0.0.1:${server.port}/?user=second-user`);
        const code = await new Promise<number>((resolve) => second.on("close", (c) => resolve(c)));
        expect(code).toBe(4004);
        expect(Object.keys(server.running.store.db.users)).toEqual(["first-user"]);
        first.close();
        await server.running.close();
    });

    it("stops creating new chat channels above maxChatChannels", async () => {
        const server = await startTestServer({ maxChatChannels: 1 });
        const client = await TestClient.connect(server.port, "chatter");
        client.send({ type: "chat", message: "hi", channel: "en" });
        await sleep(200);
        client.send({ type: "chat", message: "hallo", channel: "de" });
        await sleep(200);
        expect(Object.keys(server.running.store.db.chat)).toEqual(["en"]);
        client.close();
        await server.running.close();
    });

    it("prunes stale leaderboard snapshots on the heartbeat", async () => {
        const server = await startTestServer({ snapshotRetentionMs: 1000 });
        const client = await TestClient.connect(server.port, "stale-user");
        client.send({
            type: "tick",
            userName: "STALE",
            flag: "earth",
            dlc: 0,
            map: "Stockholm",
            cash: 1,
            resourceValuation: 1,
            buildingValuation: 1,
            buildingCount: 1,
            prestigeCurrency: 0,
            allPrestigeCurrency: 0,
        });
        await sleep(200);
        expect(server.running.store.db.snapshots["stale-user"]).toBeDefined();
        server.running.store.db.snapshots["stale-user"].updatedAt = Date.now() - 10_000;
        server.running.hub.heartbeat();
        expect(server.running.store.db.snapshots["stale-user"]).toBeUndefined();
        client.close();
        await server.running.close();
    });
});
