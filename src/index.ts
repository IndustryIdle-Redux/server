/**
 * CLI entry — `npm start` builds this bundle and runs it.
 *
 * Usage with the game: in the client open **Settings → Game Server** and enter
 * `localhost:<port>` (persisted setting — deliberately not a URL parameter), which routes
 * both the WebSocket (`src/net/Socket.ts`) and the REST calls to this process.
 */

import { configWarnings, loadConfig } from "./config";
import { createServer } from "./server";

const config = loadConfig();

// security-relevant configuration problems must be impossible to miss in the console
for (const warning of configWarnings(config)) {
    console.warn(`[server] WARNING: ${warning}`);
}

const running = createServer(config);

running
    .listen(config.port, config.host)
    .then((port) => {
        console.log(`[server] Industry Idle trade/leaderboard/chat server`);
        console.log(`[server] listening on http://${config.host}:${port} (WebSocket on the same port)`);
        console.log(`[server] data dir: ${config.dataDir}`);
        console.log(`[server] mods: ${config.mods.length ? config.mods.join(", ") : "(none)"}`);
        console.log(`[server] admin token: ${config.adminToken ? "configured" : "(not set — admin routes accept loopback callers only)"}`);
        console.log(`[server] max export size: ${config.maxExportBytes ? `${config.maxExportBytes} bytes` : "unlimited"}`);
        console.log(`[server] stale trade TTL: ${config.staleTradeTtlMs ? `${config.staleTradeTtlMs} ms` : "(disabled)"}`);
        console.log(`[server] connect the game via Settings → Game Server: ${config.host === "0.0.0.0" || config.host === "::" ? "localhost" : config.host}:${port}`);
    })
    .catch((e) => {
        console.error("[server] failed to start:", e);
        process.exit(1);
    });

for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
        console.log(`[server] ${signal} received, shutting down…`);
        running.close().then(() => process.exit(0));
    });
}
