/**
 * One place to resolve the client ip.
 *
 * `X-Forwarded-For` is client controlled, so it is ignored unless
 * `trustForwardedFor` is enabled explicitly (reverse-proxy deployments). The admin
 * routes never use it; they decide loopback from the socket address.
 */

import type { IncomingMessage } from "node:http";

export function clientIp(req: IncomingMessage, trustForwardedFor: boolean): string {
    if (trustForwardedFor) {
        const forwarded = req.headers["x-forwarded-for"];
        if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0]?.trim() || "unknown";
    }
    return (req.socket.remoteAddress ?? "unknown").replace(/^::ffff:/, "");
}
