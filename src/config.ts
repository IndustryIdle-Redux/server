/**
 * Server configuration.
 *
 * Resolution order (later wins):
 *   1. built-in defaults
 *   2. `config.json` next to the server working directory (see `config.example.json`)
 *   3. environment variables (`PORT`, `HOST`, `DATA_DIR`, `SAVE_FILE_KEY`, `MODS`,
 *      `ADMIN_TOKEN`, `MAX_EXPORT_BYTES`)
 *
 * `saveFileKey` **must match the game client's `SAVE_FILE_KEY`** (the client reads it from
 * its generated `Config.ts`), otherwise trade signatures cannot be verified. Both default
 * to the empty string; set `saveFileKey` in `config.json` or `SAVE_FILE_KEY` in the
 * environment when you have changed the client's key.
 *
 * Security defaults (see `README.md`):
 *   - `host` defaults to loopback (`127.0.0.1`), not `0.0.0.0`.
 *   - `mods` defaults to `[]` (nobody is a moderator). `["*"]` still works but is an
 *     explicit, loudly-warned opt-in that makes everybody a moderator.
 *   - `adminToken` is empty; without it the admin routes only accept loopback callers.
 */

import fs from "node:fs";
import path from "node:path";

/** default cap for the WebSocket `export` save dump (same order of magnitude as REST's 8 MB body cap) */
export const DEFAULT_MAX_EXPORT_BYTES = 8 * 1024 * 1024;

export interface ServerConfig {
    /** HTTP + WebSocket listen port (both protocols share one port) */
    port: number;
    host: string;
    /** directory for db.json / exported saves */
    dataDir: string;
    /** secret suffix used by the client's `signTrade`; must match the client */
    saveFileKey: string;
    /**
     * user ids (or `"*"`) that get the in-game moderator flag (chat ip visibility) and
     * admin rights when no `adminToken` is configured.
     *
     * The identity behind a moderator check is the client-supplied `X-User-Id` header /
     * `?user=` query — it is not authenticated, so this list is only meaningful when the
     * operator trusts everyone who can reach the server. When `adminToken` is set, the
     * admin REST routes require that token instead.
     */
    mods: string[];
    /**
     * optional shared secret for the admin routes (`POST /trade/remove`,
     * `POST /chat/mute`), sent by clients as `X-Admin-Token` (env `ADMIN_TOKEN`).
     * Empty = not configured: those routes then accept loopback callers only.
     */
    adminToken: string;
    /** minimum seconds between chat messages per user (the client enforces 10s for non-DLC) */
    chatRateLimitMs: number;
    /** chat history kept per channel */
    chatHistorySize: number;
    /** orders older than this that are still `open` get swept (0 = never) */
    staleTradeTtlMs: number;
    /** max size in bytes of a WS `export` save dump; larger payloads are rejected (0 = unlimited) */
    maxExportBytes: number;
    /**
     * trust `X-Forwarded-For` for the client ip (chat mutes, stored user ip).
     * Only enable this behind a reverse proxy that overwrites the header.
     */
    trustForwardedFor: boolean;
    /**
     * trust new users by default (self-hosted: no platform verification available).
     *
     * Only affects the verification result: `authenticated` is initialised to this
     * value and `/user/verification` reports `trusted: true`. It grants **no** admin
     * rights, no moderator rights and no bypass of the trade-token checks.
     */
    trustAll: boolean;
}

const DEFAULTS: ServerConfig = {
    // NOTE: not 5000 — macOS AirPlay Receiver (ControlCenter) occupies it
    port: 5185,
    // loopback only: the game is configured with `localhost:<port>`, and binding
    // 0.0.0.0 by default would expose chat/trade (and the spoofable moderator list)
    host: "127.0.0.1",
    dataDir: "data",
    saveFileKey: "",
    // empty = nobody is a moderator (the old `["*"]` default made everyone an admin)
    mods: [],
    adminToken: "",
    chatRateLimitMs: 3000,
    chatHistorySize: 200,
    staleTradeTtlMs: 0,
    maxExportBytes: DEFAULT_MAX_EXPORT_BYTES,
    trustForwardedFor: false,
    trustAll: true,
};

/** true for host names that only accept connections from the local machine */
export function isLoopbackHost(host: string): boolean {
    const h = (host ?? "").trim().toLowerCase().replace(/^\[|\]$/g, "");
    return h === "localhost" || h === "::1" || h === "127.0.0.1" || h.startsWith("127.");
}

/**
 * true for a socket remote address that is the local machine.
 *
 * Deliberately computed from the **socket**, never from `X-Forwarded-For`: that
 * header is client controlled and would let anybody claim to be loopback.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
    const a = (address ?? "").replace(/^::ffff:/, "");
    return a === "localhost" || a === "::1" || a === "127.0.0.1" || a.startsWith("127.");
}

export function loadConfig(cwd = process.cwd()): ServerConfig {
    const config: ServerConfig = { ...DEFAULTS };
    const file = path.resolve(cwd, "config.json");
    if (fs.existsSync(file)) {
        try {
            const json = JSON.parse(fs.readFileSync(file, "utf8"));
            Object.assign(config, json);
        } catch (e) {
            console.error(`[config] failed to parse ${file}:`, e);
        }
    }
    if (process.env.PORT) config.port = Number(process.env.PORT);
    if (process.env.HOST) config.host = process.env.HOST;
    if (process.env.DATA_DIR) config.dataDir = process.env.DATA_DIR;
    if (process.env.SAVE_FILE_KEY !== undefined) config.saveFileKey = process.env.SAVE_FILE_KEY;
    if (process.env.MODS !== undefined) config.mods = process.env.MODS.split(",").map((s) => s.trim()).filter(Boolean);
    if (process.env.ADMIN_TOKEN !== undefined) config.adminToken = process.env.ADMIN_TOKEN;
    if (process.env.MAX_EXPORT_BYTES !== undefined) {
        const n = Number(process.env.MAX_EXPORT_BYTES);
        if (Number.isFinite(n) && n >= 0) config.maxExportBytes = n;
    }
    if (process.env.TRUST_FORWARDED_FOR !== undefined) {
        config.trustForwardedFor = /^(1|true|yes|on)$/i.test(process.env.TRUST_FORWARDED_FOR.trim());
    }

    // normalise whatever config.json contained so a typo cannot silently weaken the server
    config.host = typeof config.host === "string" && config.host.trim() ? config.host.trim() : DEFAULTS.host;
    config.mods = Array.isArray(config.mods) ? config.mods.filter((m) => typeof m === "string" && m).map(String) : [];
    config.adminToken = typeof config.adminToken === "string" ? config.adminToken : "";
    config.maxExportBytes = Number.isFinite(config.maxExportBytes) && config.maxExportBytes >= 0 ? config.maxExportBytes : DEFAULTS.maxExportBytes;
    config.staleTradeTtlMs = Number.isFinite(config.staleTradeTtlMs) && config.staleTradeTtlMs > 0 ? config.staleTradeTtlMs : 0;
    config.trustForwardedFor = config.trustForwardedFor === true;
    // an empty key is a valid configuration (the client ships with an empty default too),
    // but both sides must agree on it
    config.saveFileKey = typeof config.saveFileKey === "string" ? config.saveFileKey : "";
    return config;
}

/**
 * Security-relevant warnings to print at startup (`index.ts`). Kept as a pure
 * function so the exact wording is covered by tests.
 */
export function configWarnings(config: ServerConfig): string[] {
    const warnings: string[] = [];
    if (config.mods.includes("*")) {
        warnings.push(
            'mods contains "*": EVERY user is a moderator. POST /trade/remove and POST /chat/mute are effectively ' +
                "unauthenticated admin endpoints (they are keyed only on the spoofable X-User-Id header). " +
                "Leave mods empty and set ADMIN_TOKEN instead."
        );
    } else if (config.mods.length > 0 && !config.adminToken) {
        warnings.push(
            `mods is set to [${config.mods.join(", ")}] but ADMIN_TOKEN is empty: moderator rights are keyed only on the ` +
                "client-supplied X-User-Id header, which anybody can spoof. Set ADMIN_TOKEN for a real credential."
        );
    } else if (config.mods.length > 0 && config.adminToken) {
        warnings.push(
            `mods is set to [${config.mods.join(", ")}] while ADMIN_TOKEN is configured: the admin endpoints require the ` +
                "token; the mods list only controls the in-game moderator flag."
        );
    }
    if (config.trustForwardedFor) {
        warnings.push(
            "trustForwardedFor is enabled: the client ip is taken from X-Forwarded-For, which the caller can forge. " +
                "Only enable this behind a reverse proxy that overwrites the header."
        );
    }
    if (!isLoopbackHost(config.host) && !config.adminToken) {
        warnings.push(
            `listening on ${config.host} (non-loopback) without ADMIN_TOKEN: /trade/remove and /chat/mute will reject ` +
                "non-loopback callers (set ADMIN_TOKEN to administer the server remotely)."
        );
    }
    return warnings;
}
