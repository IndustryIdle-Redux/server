/**
 * Security / configuration regression tests for the audit fixes:
 *
 *   1. safe defaults (`host` loopback, `mods: []`) + startup warnings
 *   2. admin credential for `/trade/remove` and `/chat/mute`
 *   3. trade-token ownership proof for `/trade/force-restore` and `/trade/import-save`
 *   4. WebSocket `export` size cap
 *   5. `staleTradeTtlMs` reaping
 *
 * The trade-token tests use the real REST routes over loopback, exactly like the game
 * client (`src/shared/state/GameData.ts`), so they double as an end-to-end auth check.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    DEFAULT_MAX_EXPORT_BYTES,
    configWarnings,
    loadConfig,
    type ServerConfig,
} from "../src/config";
import { createServer, type RunningServer } from "../src/server";
import { Hub, safeFileSegment } from "../src/ws";
import { Store } from "../src/store";
import { constantTimeEqual, isAdminAuthorized } from "../src/rest";
import { TestClient, testConfig, tradeMessage } from "./helpers";

/* ------------------------------------------------------------------ helpers */

/** env vars loadConfig reads — snapshot/restore around each test */
const ENV_KEYS = ["PORT", "HOST", "DATA_DIR", "SAVE_FILE_KEY", "MODS", "ADMIN_TOKEN", "MAX_EXPORT_BYTES"] as const;

function withoutEnv<T>(fn: () => T): T {
    const saved = new Map<string, string | undefined>();
    for (const key of ENV_KEYS) {
        saved.set(key, process.env[key]);
        delete process.env[key];
    }
    try {
        return fn();
    } finally {
        for (const [key, value] of saved) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
    }
}

interface Started {
    running: RunningServer;
    config: ServerConfig;
    port: number;
    http: string;
    close(): Promise<void>;
}

async function start(config: ServerConfig): Promise<Started> {
    const running = createServer(config);
    const port = await running.listen(0, "127.0.0.1");
    return { running, config, port, http: `http://127.0.0.1:${port}`, close: () => running.close() };
}

const open: Started[] = [];
afterEach(async () => {
    while (open.length) await open.pop()!.close();
});

async function startTracked(config: ServerConfig): Promise<Started> {
    const started = await start(config);
    open.push(started);
    return started;
}

function jsonHeaders(userId: string, extra: Record<string, string> = {}): Record<string, string> {
    return { "X-User-Id": userId, "Content-Type": "application/json", ...extra };
}

/** create a user record the way the game does (authentication), then bind `token` if given */
async function bindToken(server: Started, userId: string, token?: string): Promise<void> {
    await fetch(`${server.http}/user/authentication?user=${userId}&platform=web&version=test`, {
        method: "POST",
        headers: jsonHeaders(userId),
    });
    if (token) {
        const r = await fetch(`${server.http}/user/verification?tradeToken=${token}`, {
            method: "POST",
            headers: jsonHeaders(userId),
        });
        expect(await r.json()).toMatchObject({ rightToTrade: true });
    }
}

/* ------------------------------------------------------------------ config */

describe("configuration defaults", () => {
    it("defaults to loopback, no moderators and no admin token", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ii-config-"));
        const config = withoutEnv(() => loadConfig(cwd));
        expect(config.host).toBe("127.0.0.1");
        expect(config.mods).toEqual([]);
        expect(config.adminToken).toBe("");
        expect(config.staleTradeTtlMs).toBe(0);
        expect(config.maxExportBytes).toBe(DEFAULT_MAX_EXPORT_BYTES);
        expect(config.trustAll).toBe(true);
    });

    it("reads the new options from the environment", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ii-config-"));
        const config = withoutEnv(() => {
            process.env.HOST = "0.0.0.0";
            process.env.MODS = "alice, bob";
            process.env.ADMIN_TOKEN = "s3cret";
            process.env.MAX_EXPORT_BYTES = "1024";
            return loadConfig(cwd);
        });
        expect(config.host).toBe("0.0.0.0");
        expect(config.mods).toEqual(["alice", "bob"]);
        expect(config.adminToken).toBe("s3cret");
        expect(config.maxExportBytes).toBe(1024);
    });

    it("normalises a broken mods / maxExportBytes value instead of trusting it", () => {
        const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "ii-config-"));
        fs.writeFileSync(path.join(cwd, "config.json"), JSON.stringify({ mods: "*", maxExportBytes: -1, adminToken: 42 }));
        const config = withoutEnv(() => loadConfig(cwd));
        expect(config.mods).toEqual([]);
        expect(config.maxExportBytes).toBe(DEFAULT_MAX_EXPORT_BYTES);
        expect(config.adminToken).toBe("");
    });

    it("warns loudly about mods: ['*'] and about a non-loopback bind without ADMIN_TOKEN", () => {
        const star = configWarnings({ ...testConfig({ mods: ["*"], host: "127.0.0.1" }) });
        expect(star.some((w) => w.includes('mods contains "*"'))).toBe(true);
        expect(star.some((w) => w.includes("non-loopback"))).toBe(false);

        const exposed = configWarnings(testConfig({ mods: [], host: "0.0.0.0" }));
        expect(exposed.some((w) => w.includes("non-loopback") && w.includes("ADMIN_TOKEN"))).toBe(true);

        // with a token configured the remote deploy is fine
        expect(configWarnings(testConfig({ mods: [], host: "0.0.0.0", adminToken: "x" }))).toEqual([]);
    });

    it("keeps isMod working for the configured list and for '*'", () => {
        const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "ii-mod-")));
        expect(new Hub(store, testConfig({ mods: [] })).isMod("anyone")).toBe(false);
        expect(new Hub(store, testConfig({ mods: ["alice"] })).isMod("alice")).toBe(true);
        expect(new Hub(store, testConfig({ mods: ["alice"] })).isMod("bob")).toBe(false);
        expect(new Hub(store, testConfig({ mods: ["*"] })).isMod("bob")).toBe(true);
    });

    it("constant-time compare rejects empty/unequal values", () => {
        expect(constantTimeEqual("abc", "abc")).toBe(true);
        expect(constantTimeEqual("abc", "abd")).toBe(false);
        expect(constantTimeEqual("abc", "abcd")).toBe(false);
        expect(constantTimeEqual("", "")).toBe(false);
        expect(constantTimeEqual("", "abc")).toBe(false);
    });
});

/* ------------------------------------------------------------------ admin auth */

describe("admin route authorization", () => {
    it("keeps legacy behaviour for loopback callers when no ADMIN_TOKEN is set", async () => {
        const server = await startTracked(testConfig({ mods: [], adminToken: "" }));
        const mute = await fetch(`${server.http}/chat/mute?ip=198.51.100.7&time=1`, {
            method: "POST",
            headers: jsonHeaders("random-user"),
        });
        expect(mute.status).toBe(200);
        const remove = await fetch(`${server.http}/trade/remove?id=nope`, {
            method: "POST",
            headers: jsonHeaders("random-user"),
        });
        expect(remove.status).toBe(404); // authorized, trade simply does not exist
    });

    it("requires X-Admin-Token when one is configured", async () => {
        const server = await startTracked(testConfig({ mods: [], adminToken: "s3cret" }));
        const noToken = await fetch(`${server.http}/chat/mute?ip=1.2.3.4&time=1`, {
            method: "POST",
            headers: jsonHeaders("attacker"),
        });
        expect(noToken.status).toBe(403);
        expect(await noToken.text()).toContain("X-Admin-Token");

        const wrongToken = await fetch(`${server.http}/trade/remove?id=nope`, {
            method: "POST",
            headers: jsonHeaders("attacker", { "X-Admin-Token": "nope" }),
        });
        expect(wrongToken.status).toBe(403);

        const good = await fetch(`${server.http}/chat/mute?ip=1.2.3.4&time=1`, {
            method: "POST",
            headers: jsonHeaders("operator", { "X-Admin-Token": "s3cret" }),
        });
        expect(good.status).toBe(200);
    });

    it("still lets configured mods administer when a token is set", async () => {
        const server = await startTracked(testConfig({ mods: ["moddy"], adminToken: "s3cret" }));
        const r = await fetch(`${server.http}/trade/remove?id=nope`, {
            method: "POST",
            headers: jsonHeaders("moddy"),
        });
        expect(r.status).toBe(404); // mod path accepted
    });

    it("denies non-loopback callers without a token and never trusts X-Forwarded-For", () => {
        const config = testConfig({ mods: [], adminToken: "" });
        const hub = new Hub(new Store(fs.mkdtempSync(path.join(os.tmpdir(), "ii-auth-"))), config);
        const remote = (headers: Record<string, string> = {}): IncomingMessage =>
            ({ socket: { remoteAddress: "203.0.113.5" }, headers }) as unknown as IncomingMessage;

        // someone spoofing X-Forwarded-For: 127.0.0.1 must NOT be treated as loopback
        expect(isAdminAuthorized(remote({ "x-forwarded-for": "127.0.0.1" }), hub, config, "attacker")).toBe(false);
        // a genuine loopback socket is fine
        const local = { socket: { remoteAddress: "::ffff:127.0.0.1" }, headers: {} } as unknown as IncomingMessage;
        expect(isAdminAuthorized(local, hub, config, "attacker")).toBe(true);
        // an explicitly configured mod is accepted remotely …
        const modHub = new Hub(new Store(fs.mkdtempSync(path.join(os.tmpdir(), "ii-auth-"))), testConfig({ mods: ["moddy"] }));
        expect(isAdminAuthorized(remote(), modHub, testConfig({ mods: ["moddy"] }), "moddy")).toBe(true);
        // … and the token wins even for a remote caller
        const tokenConfig = testConfig({ mods: [], adminToken: "s3cret" });
        const tokenHub = new Hub(new Store(fs.mkdtempSync(path.join(os.tmpdir(), "ii-auth-"))), tokenConfig);
        expect(isAdminAuthorized(remote({ "x-admin-token": "s3cret" }), tokenHub, tokenConfig, "attacker")).toBe(true);
        expect(isAdminAuthorized(remote({ "x-admin-token": "s3cret " }), tokenHub, tokenConfig, "attacker")).toBe(false);
    });
});

/* ------------------------------------------------------------------ token proof */

describe("trade token ownership proof", () => {
    it("force-restore requires the current token (query or X-Trade-Token)", async () => {
        const server = await startTracked(testConfig({ mods: [] }));
        await bindToken(server, "fr-user", "fr-current-token");

        const wrong = await fetch(`${server.http}/trade/force-restore?token=not-my-token`, {
            method: "POST",
            headers: jsonHeaders("fr-user"),
        });
        expect(wrong.status).toBe(403);

        const query = await fetch(`${server.http}/trade/force-restore?token=fr-current-token`, {
            method: "POST",
            headers: jsonHeaders("fr-user"),
        });
        expect(query.status).toBe(200);

        const header = await fetch(`${server.http}/trade/force-restore`, {
            method: "POST",
            headers: jsonHeaders("fr-user", { "X-Trade-Token": "fr-current-token" }),
        });
        expect(header.status).toBe(200);

        const nobody = await fetch(`${server.http}/trade/force-restore?token=whatever`, {
            method: "POST",
            headers: jsonHeaders("unknown-user"),
        });
        expect(nobody.status).toBe(403);
    });

    it("import-save binds a first token when none is bound yet", async () => {
        const server = await startTracked(testConfig({ mods: [] }));
        const r = await fetch(`${server.http}/trade/import-save?token=fresh-save-token`, {
            method: "POST",
            headers: jsonHeaders("brand-new"),
        });
        expect(r.status).toBe(200);
        const body = await r.json();
        expect(typeof body.token).toBe("string");
        expect(server.running.store.db.tokens[body.token]).toBe("brand-new");
    });

    it("import-save denies rotating an already-bound token without proof", async () => {
        const server = await startTracked(testConfig({ mods: [] }));
        await bindToken(server, "victim", "victim-live-token");
        const before = server.running.store.db.users["victim"].tradeToken;

        // attacker knows the userId only and posts an unbound token
        const r = await fetch(`${server.http}/trade/import-save?token=attacker-chosen-token`, {
            method: "POST",
            headers: jsonHeaders("victim"),
        });
        expect(r.status).toBe(403);
        expect(server.running.store.db.users["victim"].tradeToken).toBe(before);
        expect(server.running.store.db.tokens[before]).toBe("victim");
        expect(server.running.store.db.tokens["attacker-chosen-token"]).toBeUndefined();
    });

    it("import-save rotates with proof (X-Trade-Token) or with the live token itself", async () => {
        const server = await startTracked(testConfig({ mods: [] }));
        await bindToken(server, "importer", "importer-live-token");

        const withProof = await fetch(`${server.http}/trade/import-save?token=unbound-new-token`, {
            method: "POST",
            headers: jsonHeaders("importer", { "X-Trade-Token": "importer-live-token" }),
        });
        expect(withProof.status).toBe(200);
        const fresh = (await withProof.json()).token;
        expect(server.running.store.db.tokens[fresh]).toBe("importer");
        expect(server.running.store.db.tokens["importer-live-token"]).toBeUndefined(); // proof-carrying rotation revokes

        // presenting the currently-bound token is itself the proof
        await bindToken(server, "importer2", "importer2-live-token");
        const withLive = await fetch(`${server.http}/trade/import-save?token=importer2-live-token`, {
            method: "POST",
            headers: jsonHeaders("importer2"),
        });
        expect(withLive.status).toBe(200);
        expect((await withLive.json()).token).not.toBe("importer2-live-token");
    });

    it("adoptToken no longer lets a stranger revoke the victim's token", async () => {
        const store = new Store(fs.mkdtempSync(path.join(os.tmpdir(), "ii-adopt-")));
        store.db.users["v"] = {
            userId: "v",
            tradeToken: "v-live",
            userName: "V",
            flag: "earth",
            dlc: 0,
            authenticated: true,
            createdAt: 0,
            lastSeenAt: 0,
            ip: "127.0.0.1",
            platform: "web",
            version: "",
        };
        store.db.tokens["v-live"] = "v";
        expect(store.adoptToken("v", "attacker-token")).toBe(true);
        expect(store.db.users["v"].tradeToken).toBe("attacker-token");
        // …but the victim's original token keeps working, so rotation is not a lockout
        expect(store.db.tokens["v-live"]).toBe("v");
        expect(store.hasBoundToken("v")).toBe(true);
    });
});

/* ------------------------------------------------------------------ WS export cap */

describe("WebSocket export size cap", () => {
    it("rejects oversized save dumps but stores normal ones", async () => {
        const server = await startTracked(testConfig({ maxExportBytes: 64 }));
        const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
        const client = await TestClient.connect(server.port, "exporter");
        const saves = path.join(server.config.dataDir, "saves");

        client.send({ type: "export", data: { blob: "x".repeat(500) } });
        await new Promise((r) => setTimeout(r, 200));
        expect(warn.mock.calls.some((c) => String(c[0]).includes("rejected oversized"))).toBe(true);
        expect(fs.existsSync(saves) ? fs.readdirSync(saves) : []).toHaveLength(0);

        client.send({ type: "export", data: { ok: true } });
        await vi.waitFor(() => expect(fs.existsSync(saves) && fs.readdirSync(saves).length).toBe(1), { timeout: 2000 });
        const file = path.join(saves, fs.readdirSync(saves)[0]);
        expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ ok: true });

        warn.mockRestore();
        client.close();
    });

    it("sanitises the user id used in the stored file name (no path traversal)", async () => {
        const server = await startTracked(testConfig({ maxExportBytes: DEFAULT_MAX_EXPORT_BYTES }));
        const client = await TestClient.connect(server.port, "../../evil");
        const saves = path.join(server.config.dataDir, "saves");
        client.send({ type: "export", data: { ok: true } });
        await vi.waitFor(() => expect(fs.existsSync(saves) && fs.readdirSync(saves).length).toBe(1), { timeout: 2000 });
        const entries = fs.readdirSync(saves);
        expect(entries[0].startsWith("evil") || entries[0].startsWith("_")).toBe(true);
        expect(entries[0]).not.toContain("/");
        // nothing escaped next to the saves directory
        expect(fs.readdirSync(server.config.dataDir).filter((f) => f.startsWith("evil"))).toEqual([]);
        expect(safeFileSegment("../../evil")).not.toContain("/");
        expect(safeFileSegment("../../evil")).not.toBe("../../evil");
        client.close();
    });
});

/* ------------------------------------------------------------------ TTL reaping */

describe("stale trade reaping", () => {
    it("cancels open orders older than the TTL and moves them to history", async () => {
        const server = await startTracked(testConfig({ mods: [], staleTradeTtlMs: 100 }));
        const client = await TestClient.connect(server.port, "sweeper");
        client.send({ type: "join", channel: "en" });
        await client.waitType("trade");

        const reply = await client.request(
            tradeMessage("sweeper", { id: "stale-1", side: "sell", resource: "Fe", amount: 10, price: 3, token: "sweeper-token" })
        );
        expect(reply.error).toBeUndefined();
        await vi.waitFor(async () => {
            const history = await (await fetch(`${server.http}/trade/history`, { headers: jsonHeaders("sweeper") })).json();
            expect(history.some((h: any) => h.id === "stale-1" && h.status === "cancelled")).toBe(true);
        }, { timeout: 3000 });
        client.close();
    });

    it("never sweeps when the TTL is 0 (default/disabled)", async () => {
        const server = await startTracked(testConfig({ mods: [], staleTradeTtlMs: 0 }));
        expect(server.running.hub.trades.sweepStale(Date.now() + 60_000)).toBe(0);
    });
});
