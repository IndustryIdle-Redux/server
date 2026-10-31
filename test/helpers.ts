/** Shared test helpers: temp-dir server + scripted websocket client. */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import WebSocket from "ws";
import { DEFAULT_MAX_EXPORT_BYTES, type ServerConfig } from "../src/config";
import { createServer, type RunningServer } from "../src/server";
import { murmurhash3 } from "../src/hash";

export const SAVE_KEY = "TEST_SAVE_KEY";

/**
 * Test config with the **safe production defaults** (loopback host, no mods, no admin
 * token). Tests that need moderation/admin pass `mods`/`adminToken` explicitly, which
 * also documents that those are deliberate opt-ins.
 */
export function testConfig(overrides: Partial<ServerConfig> = {}): ServerConfig {
    return {
        port: 0,
        host: "127.0.0.1",
        dataDir: fs.mkdtempSync(path.join(os.tmpdir(), "ii-server-test-")),
        saveFileKey: SAVE_KEY,
        mods: [],
        adminToken: "",
        chatRateLimitMs: 0,
        chatHistorySize: 200,
        staleTradeTtlMs: 0,
        maxExportBytes: DEFAULT_MAX_EXPORT_BYTES,
        trustForwardedFor: false,
        maxWsPayloadBytes: 10 * 1024 * 1024,
        wsRateLimitPerSecond: 0,
        exportMinIntervalMs: 0,
        trustAll: true,
        ...overrides,
    };
}

export async function startTestServer(overrides: Partial<ServerConfig> = {}): Promise<{
    running: RunningServer;
    port: number;
    http: string;
    config: ServerConfig;
}> {
    const config = testConfig(overrides);
    const running = createServer(config);
    const port = await running.listen(0, "127.0.0.1");
    return { running, port, http: `http://127.0.0.1:${port}`, config };
}

/** re-implements the client's `GameData.signTrade` exactly (see src/shared/state/GameData.ts) */
export function signTrade(data: Record<string, unknown>, now = Date.now()): Record<string, unknown> {
    delete data.sig;
    const str =
        Object.keys(data)
            .sort()
            .map((k) => JSON.stringify(data[k]))
            .join() + SAVE_KEY;
    data.sig = murmurhash3(str, Math.floor(now / 5000)).toString(16);
    return data;
}

interface Waiter {
    pred: (m: Record<string, any>) => boolean;
    resolve: (m: Record<string, any>) => void;
}

/** scripted websocket client speaking the game protocol */
export class TestClient {
    public readonly received: Record<string, any>[] = [];
    public userId: string;
    private ws: WebSocket;
    private waiters: Waiter[] = [];
    private openPromise: Promise<void>;
    /** resolves with the close code/reason when the server (or the test) closes the socket */
    public readonly closed: Promise<{ code: number; reason: string }>;

    private constructor(userId: string, ws: WebSocket) {
        this.userId = userId;
        this.ws = ws;
        ws.on("message", (raw) => {
            const m = JSON.parse(raw.toString());
            this.received.push(m);
            const idx = this.waiters.findIndex((w) => w.pred(m));
            if (idx >= 0) {
                this.waiters.splice(idx, 1)[0].resolve(m);
            }
        });
        this.openPromise = new Promise((resolve, reject) => {
            ws.once("open", () => resolve());
            ws.once("error", reject);
        });
        this.closed = new Promise((resolve) => {
            ws.once("close", (code, reason) => resolve({ code, reason: reason.toString() }));
        });
    }

    public static async connect(port: number, userId: string, query = ""): Promise<TestClient> {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/?user=${userId}&platform=web&version=test${query}`);
        const client = new TestClient(userId, ws);
        await client.openPromise;
        return client;
    }

    public send(message: Record<string, unknown>): void {
        this.ws.send(JSON.stringify(message));
    }

    /** resolve with the first (existing or future) message matching `pred` */
    public wait(pred: (m: Record<string, any>) => boolean, timeoutMs = 3000): Promise<Record<string, any>> {
        const existing = this.received.find(pred);
        if (existing) return Promise.resolve(existing);
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout waiting for message (got: ${this.received.map((m) => m.type).join(", ")})`)), timeoutMs);
            this.waiters.push({
                pred,
                resolve: (m) => {
                    clearTimeout(timer);
                    resolve(m);
                },
            });
        });
    }

    public waitType(type: string, extra?: (m: Record<string, any>) => boolean, timeoutMs = 3000) {
        return this.wait((m) => m.type === type && (!extra || extra(m)), timeoutMs);
    }

    /** send a message carrying `id` and wait for the server's correlated reply */
    public async request(message: Record<string, any>, timeoutMs = 3000): Promise<Record<string, any>> {
        // NOTE: the waiter only sees messages that arrive after the send — trade ids are
        // reused across the open/fill/claim lifecycle, so stale replies must not match
        const reply = new Promise<Record<string, any>>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timeout waiting for reply to ${message.id}`)), timeoutMs);
            this.waiters.push({
                pred: (m) => m.id === message.id,
                resolve: (m) => {
                    clearTimeout(timer);
                    resolve(m);
                },
            });
        });
        this.send(message);
        return reply;
    }

    public close(): void {
        this.ws.close();
    }
}

/** build a `trade` message exactly like `PlayerTrade.newTrade()` + `signTrade()` */
export function tradeMessage(
    userId: string,
    fields: Partial<Record<string, unknown>> & { id: string; side: string; resource: string; amount: number; price: number }
): Record<string, any> {
    const msg: Record<string, unknown> = {
        type: "trade",
        fromUserId: userId,
        fromUserHash: "deadbeef",
        from: userId.substring(0, 6).toUpperCase(),
        fillBy: null,
        status: "open",
        createdAt: Date.now(),
        token: "TOKEN",
    };
    Object.assign(msg, fields);
    // JSON drops undefined keys on the wire — drop them before signing too,
    // otherwise the server's recomputed signature would not match
    for (const k of Object.keys(msg)) {
        if (msg[k] === undefined) delete msg[k];
    }
    return signTrade(msg) as Record<string, any>;
}
