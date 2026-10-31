import { describe, expect, it } from "vitest";
import type { IncomingMessage } from "node:http";
import { clientIp } from "../src/ip";

function req(remoteAddress: string, headers: Record<string, string> = {}): IncomingMessage {
    return { socket: { remoteAddress }, headers } as unknown as IncomingMessage;
}

describe("clientIp", () => {
    it("uses the socket address and ignores X-Forwarded-For by default", () => {
        expect(clientIp(req("203.0.113.5", { "x-forwarded-for": "9.9.9.9" }), false)).toBe("203.0.113.5");
    });

    it("uses the first forwarded address when it is explicitly trusted", () => {
        expect(clientIp(req("203.0.113.5", { "x-forwarded-for": "9.9.9.9" }), true)).toBe("9.9.9.9");
        expect(clientIp(req("203.0.113.5", { "x-forwarded-for": "1.2.3.4, 5.6.7.8" }), true)).toBe("1.2.3.4");
        expect(clientIp(req("203.0.113.5"), true)).toBe("203.0.113.5");
    });

    it("strips the IPv4-mapped prefix", () => {
        expect(clientIp(req("::ffff:127.0.0.1"), false)).toBe("127.0.0.1");
    });
});
