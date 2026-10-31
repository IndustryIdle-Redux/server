/**
 * Small input normalisers for untrusted client messages.
 *
 * Every field that ends up in memory, on disk or in a broadcast goes through one of these;
 * a WebSocket message can be up to `maxWsPayloadBytes`, so string lengths and numeric ranges
 * must be bounded here rather than at the point of use.
 */

/** trimmed string, capped at `maxLength`; non-strings become `fallback` */
export function clampString(value: unknown, maxLength: number, fallback = ""): string {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    return trimmed.length > maxLength ? trimmed.slice(0, maxLength) : trimmed;
}

/** finite number or `fallback` */
export function finiteNumber(value: unknown, fallback = 0): number {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/** finite number clamped into [min, max] */
export function boundedNumber(value: unknown, min: number, max: number, fallback = 0): number {
    const n = finiteNumber(value, fallback);
    return n < min ? min : n > max ? max : n;
}

/** integer clamped into [min, max] */
export function boundedInt(value: unknown, min: number, max: number, fallback = 0): number {
    return Math.trunc(boundedNumber(value, min, max, fallback));
}

const CHANNEL_PATTERN = /^[a-z0-9_-]{1,16}$/;

/** chat channel: client channels are short locale codes; anything else falls back to "en" */
export function sanitizeChannel(value: unknown, fallback = "en"): string {
    if (typeof value !== "string") return fallback;
    const channel = value.trim().toLowerCase();
    if (channel.length === 0 || channel.length > 16) return fallback;
    return CHANNEL_PATTERN.test(channel) ? channel : fallback;
}
