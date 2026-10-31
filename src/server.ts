/**
 * Server assembly — one HTTP port carries both the REST API and the WebSocket
 * endpoint (the client derives both from the same `?server=` override:
 * `ws://<host>` for `Socket.ts` and `http://<host>` for `API_HOST`).
 */

import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type { ServerConfig } from "./config";
import { clientIp } from "./ip";
import { handleRest } from "./rest";
import { Store } from "./store";
import { Hub, type LiveConn } from "./ws";

export interface RunningServer {
    server: http.Server;
    hub: Hub;
    store: Store;
    /** resolved port (useful when configured with 0) */
    port: number;
    listen(port?: number, host?: string): Promise<number>;
    close(): Promise<void>;
}

export function createServer(config: ServerConfig): RunningServer {
    config.dataDir = path.resolve(config.dataDir);
    fs.mkdirSync(config.dataDir, { recursive: true });
    const store = new Store(config.dataDir);
    const hub = new Hub(store, config);

    const server = http.createServer((req, res) => {
        void handleRest(hub, store, config, req, res);
    });

    const wss = new WebSocketServer({ noServer: true, maxPayload: config.maxWsPayloadBytes });

    server.on("upgrade", (req, socket, head) => {
        wss.handleUpgrade(req, socket, head, (ws) => {
            wss.emit("connection", ws, req);
        });
    });

    wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
        const url = new URL(req.url ?? "/", "http://localhost");
        const userId = url.searchParams.get("user") ?? "";
        if (!userId) {
            ws.close(4001, "missing user");
            return;
        }
        const ip = clientIp(req, config.trustForwardedFor);
        if (!hub.hasUser(userId) && config.maxUsers > 0 && hub.userCount() >= config.maxUsers) {
            ws.close(4004, "server full");
            return;
        }
        const user = hub.ensureUser(
            userId,
            ip,
            url.searchParams.get("platform") ?? "web",
            url.searchParams.get("version") ?? ""
        );
        const conn: LiveConn = {
            ws,
            userId: user.userId,
            ip,
            isMod: hub.isMod(user.userId),
            channel: "en",
            send: (message) => {
                if (ws.readyState === ws.OPEN) {
                    ws.send(JSON.stringify(message));
                }
            },
            close: (code?: number, reason?: string) => ws.close(code, reason),
        };
        hub.addConnection(conn);
        ws.on("message", (data) => hub.handleRaw(conn, data.toString()));
        ws.on("close", () => hub.removeConnection(conn));
        ws.on("error", () => hub.removeConnection(conn));
    });

    // app-level heartbeat: the client force-reconnects if it receives nothing for ~70s
    const heartbeat = setInterval(() => hub.heartbeat(), 45_000);
    heartbeat.unref?.();

    // stale order reaping (opt-in: `staleTradeTtlMs` defaults to 0 = disabled). The sweep
    // runs at least every 250ms and at most once a minute; unref keeps the timer from
    // holding the process open.
    const sweep =
        config.staleTradeTtlMs > 0
            ? setInterval(() => hub.trades.sweepStale(), Math.max(250, Math.min(config.staleTradeTtlMs, 60_000)))
            : null;
    sweep?.unref?.();

    let closed = false;
    const close = (): Promise<void> =>
        new Promise((resolve) => {
            if (closed) return resolve();
            closed = true;
            clearInterval(heartbeat);
            if (sweep) clearInterval(sweep);
            store.close();
            for (const client of wss.clients) client.terminate();
            wss.close(() => {
                server.close(() => resolve());
            });
        });

    const result: RunningServer = {
        server,
        hub,
        store,
        port: 0,
        listen: (port = config.port, host = config.host) =>
            new Promise<number>((resolve, reject) => {
                server.once("error", reject);
                server.listen(port, host, () => {
                    const address = server.address();
                    result.port = typeof address === "object" && address ? address.port : port;
                    resolve(result.port);
                });
            }),
        close,
    };
    return result;
}
