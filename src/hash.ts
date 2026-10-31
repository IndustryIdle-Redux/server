/**
 * Signature verification for player trades.
 *
 * The client signs every trade message in `GameData.signTrade`:
 *
 * ```ts
 * delete data.sig;
 * data.token = D.persisted.tradeToken;
 * const str = Object.keys(data).sort().map((k) => JSON.stringify(data[k])).join() + SAVE_FILE_KEY;
 * data.sig = murmurhash3(str, Math.floor(serverNow() / 5000)).toString(16);
 * ```
 *
 * So the server can verify a trade without ever seeing the save key in transit:
 * re-serialize the received object the same way (sorted keys, `JSON.stringify` per
 * value, joined with `,`, plus `SAVE_FILE_KEY`) and compare the murmur3 hash for the
 * current 5-second window. Because the seed is time based, the server accepts the
 * previous / current / next window to tolerate normal clock drift.
 *
 * `murmurhash3` below is a **line-by-line port** of `src/shared/util/Helper.ts`
 * (kept in sync manually — the tests pin it against golden vectors).
 */

/** murmur3 (x86, 32bit) — exact port of the client's `murmurhash3` */
export function murmurhash3(key: string, seed: number): number {
    let remainder: number, bytes: number, h1: number, h1b: number, c1: number, c1b: number, c2: number, c2b: number, k1: number, i: number;

    remainder = key.length & 3; // key.length % 4
    bytes = key.length - remainder;
    h1 = seed;
    c1 = 0xcc9e2d51;
    c2 = 0x1b873593;
    i = 0;

    while (i < bytes) {
        k1 =
            (key.charCodeAt(i) & 0xff) |
            ((key.charCodeAt(++i) & 0xff) << 8) |
            ((key.charCodeAt(++i) & 0xff) << 16) |
            ((key.charCodeAt(++i) & 0xff) << 24);
        ++i;

        k1 = ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) & 0xffffffff;
        k1 = (k1 << 15) | (k1 >>> 17);
        k1 = ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) & 0xffffffff;

        h1 ^= k1;
        h1 = (h1 << 13) | (h1 >>> 19);
        h1b = ((h1 & 0xffff) * 5 + ((((h1 >>> 16) * 5) & 0xffff) << 16)) & 0xffffffff;
        h1 = (h1b & 0xffff) + 0x6b64 + ((((h1b >>> 16) + 0xe654) & 0xffff) << 16);
    }

    k1 = 0;

    switch (remainder) {
        case 3:
            k1 ^= (key.charCodeAt(i + 2) & 0xff) << 16;
        // falls through
        case 2:
            k1 ^= (key.charCodeAt(i + 1) & 0xff) << 8;
        // falls through
        case 1:
            k1 ^= key.charCodeAt(i) & 0xff;

            k1 = ((k1 & 0xffff) * c1 + ((((k1 >>> 16) * c1) & 0xffff) << 16)) & 0xffffffff;
            k1 = (k1 << 15) | (k1 >>> 17);
            k1 = ((k1 & 0xffff) * c2 + ((((k1 >>> 16) * c2) & 0xffff) << 16)) & 0xffffffff;
            h1 ^= k1;
    }

    h1 ^= key.length;

    h1 ^= h1 >>> 16;
    h1 = ((h1 & 0xffff) * 0x85ebca6b + ((((h1 >>> 16) * 0x85ebca6b) & 0xffff) << 16)) & 0xffffffff;
    h1 ^= h1 >>> 13;
    h1 = ((h1 & 0xffff) * 0xc2b2ae35 + ((((h1 >>> 16) * 0xc2b2ae35) & 0xffff) << 16)) & 0xffffffff;
    h1 ^= h1 >>> 16;

    return h1 >>> 0;
}

/** The 5-second signature window used by `signTrade` (`Math.floor(serverNow() / 5000)`) */
export function signatureSeed(now: number): number {
    return Math.floor(now / 5000);
}

/** Rebuild the exact string the client signs (sorted keys, JSON per value, joined with "," + saveKey) */
export function signaturePayload(data: Record<string, unknown>, saveKey: string): string {
    return (
        Object.keys(data)
            .sort()
            .map((k) => JSON.stringify(data[k]))
            .join() + saveKey
    );
}

/**
 * Verify a trade message's `sig` the way `signTrade` produced it.
 * `sig` itself is excluded (the client deletes it before signing).
 * The previous/current/next time windows are all accepted.
 */
export function verifyTradeSignature(
    message: Record<string, unknown>,
    saveKey: string,
    now: number = Date.now(),
    windowTolerance = 1
): boolean {
    const actual = message.sig;
    if (typeof actual !== "string" || !actual) {
        return false;
    }
    const data: Record<string, unknown> = { ...message };
    delete data.sig;
    const str = signaturePayload(data, saveKey);
    const base = signatureSeed(now);
    for (let d = -windowTolerance; d <= windowTolerance; d++) {
        if (murmurhash3(str, base + d).toString(16) === actual) {
            return true;
        }
    }
    return false;
}
