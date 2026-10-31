/**
 * Signature tests — pin `murmurhash3` (a manual port of the client's
 * `src/shared/util/Helper.ts`) against golden vectors computed with the **client's
 * exact implementation**, and verify `signTrade` round trips.
 */

import { describe, expect, it } from "vitest";
import { murmurhash3, signaturePayload, verifyTradeSignature, signatureSeed } from "../src/hash";
import { signTrade, SAVE_KEY } from "./helpers";

describe("murmurhash3 (golden vectors from the client implementation)", () => {
    it("matches known values", () => {
        expect(murmurhash3("hello", 0)).toBe(613153351);
        expect(murmurhash3("hello", 12345)).toBe(1321914039);
        expect(murmurhash3("", 0)).toBe(0);
        expect(murmurhash3("The quick brown fox jumps over the lazy dog", 42)).toBe(880582914);
        expect(murmurhash3("abcdef", 987654321)).toBe(2859207810);
        expect(murmurhash3("IndustryIdle", 340000000)).toBe(3848495986);
    });

    it("produces hex strings exactly like `toString(16)` on the client", () => {
        expect(murmurhash3("hello", 0).toString(16)).toBe("248bfa47");
        expect(murmurhash3("hello", 12345).toString(16)).toBe("4ecaceb7");
        expect(murmurhash3("IndustryIdle", 340000000).toString(16)).toBe("e5636372");
    });
});

describe("signTrade / verifyTradeSignature", () => {
    it("builds the same payload string as the client (sorted keys, JSON values, save key suffix)", () => {
        const data = { amount: 100, price: 3.5, resource: "Fe", side: "sell", token: "tok-1", type: "trade" };
        expect(signaturePayload(data, "SAVE")).toBe('100,3.5,"Fe","sell","tok-1","trade"SAVE');
        // golden vector computed with the client implementation at seed 344200
        expect(murmurhash3(signaturePayload(data, "SAVE"), 344200).toString(16)).toBe("5dfbca6e");
    });

    it("verifies a freshly signed trade", () => {
        const now = Date.now();
        const msg = signTrade(
            {
                id: "t-1",
                type: "trade",
                side: "sell",
                resource: "Fe",
                amount: 10,
                price: 5,
                status: "open",
                token: "tok-1",
                fillBy: null,
            },
            now
        );
        expect(verifyTradeSignature(msg, SAVE_KEY, now)).toBe(true);
    });

    it("accepts one window of clock drift", () => {
        const now = Date.now();
        const msg = signTrade({ id: "t-2", type: "trade", token: "tok-1", amount: 1, price: 1 }, now);
        expect(verifyTradeSignature(msg, SAVE_KEY, now + 4999)).toBe(true);
        expect(verifyTradeSignature(msg, SAVE_KEY, now - 4999)).toBe(true);
    });

    it("rejects tampered payloads and wrong keys", () => {
        const now = Date.now();
        const msg = signTrade({ id: "t-3", type: "trade", token: "tok-1", amount: 1, price: 1 }, now);
        expect(verifyTradeSignature({ ...msg, amount: 999 }, SAVE_KEY, now)).toBe(false);
        expect(verifyTradeSignature(msg, "OTHER_KEY", now)).toBe(false);
        expect(verifyTradeSignature({ ...msg, sig: "" }, SAVE_KEY, now)).toBe(false);
    });

    it("uses the 5s seed window", () => {
        expect(signatureSeed(0)).toBe(0);
        expect(signatureSeed(4999)).toBe(0);
        expect(signatureSeed(5000)).toBe(1);
        expect(signatureSeed(123456789)).toBe(24691);
    });
});
