import { describe, expect, it } from "vitest";
import { boundedInt, boundedNumber, clampString, finiteNumber, sanitizeChannel } from "../src/validation";

describe("message field validation", () => {
    it("clamps strings and rejects non-strings", () => {
        expect(clampString("  hello  ", 8)).toBe("hello");
        expect(clampString("abcdefghij", 4)).toBe("abcd");
        expect(clampString(42, 8, "fallback")).toBe("fallback");
        expect(clampString(undefined, 8, "fallback")).toBe("fallback");
    });

    it("keeps only finite numbers", () => {
        expect(finiteNumber(3.5)).toBe(3.5);
        expect(finiteNumber(Number.NaN, 7)).toBe(7);
        expect(finiteNumber(Number.POSITIVE_INFINITY, 7)).toBe(7);
        expect(finiteNumber("5", 7)).toBe(7);
    });

    it("clamps numbers and integers into range", () => {
        expect(boundedNumber(-5, 0, 10)).toBe(0);
        expect(boundedNumber(50, 0, 10)).toBe(10);
        expect(boundedInt(4.9, 0, 10)).toBe(4);
        expect(boundedInt(Number.NaN, 0, 10, 3)).toBe(3);
    });

    it("accepts short locale channels and falls back otherwise", () => {
        expect(sanitizeChannel("en")).toBe("en");
        expect(sanitizeChannel("zh-HK")).toBe("zh-hk");
        expect(sanitizeChannel("C".repeat(100))).toBe("en");
        expect(sanitizeChannel("../../etc")).toBe("en");
        expect(sanitizeChannel(42)).toBe("en");
    });
});
