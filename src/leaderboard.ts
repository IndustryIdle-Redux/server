/**
 * Leaderboard engine.
 *
 * The client (`src/ui/pages/LeaderboardPage.ts`) renders `GET /leaderboard/v4?name=<board>`
 * as `{ data, updatedAt }`. Row shapes depend on the board:
 *
 * | board | row |
 * |---|---|
 * | `byX` (normal) | `[value, userName, dlc, flag, map]` — `dlc` selects `images/Exp{n}.png`, `map` must be a valid `MAP` key |
 * | `byFlag` | `[flag, playerCount, valuationPerHour, swissMoney]` |
 * | `byMap` | `[map, playerCount, valuationPerHour, swissMoney]` |
 *
 * Every metric is computed from the latest `tick` message of each player
 * (`getTickMessage()` in `src/net/Socket.ts`), which reports cash / resource valuation /
 * building valuation / map / flag / prestige currency / opt-out etc.
 *
 * `valuation` follows the client's own definition (`getValuation()` in
 * `src/features/factory/Logic.ts`): `resourceValuation + buildingValuation`.
 * `valuationPerHour` is the smoothed hourly growth of that valuation, measured from
 * consecutive ticks (exponential moving average over ~1h; the game ticks once a minute).
 */

import type { Db, TickSnapshot } from "./store";

/** map ids of `Maps` in `src/shared/domain/MapDefinitions.ts` (client renders `MAP[item[4]].name()`) */
export const KNOWN_MAPS = [
    "Stockholm",
    "Oslo",
    "Rotterdam",
    "StPetersburg",
    "Detroit",
    "Rome",
    "Toulouse",
    "Hamburg",
    "Boston",
    "Osaka",
    "HongKong",
    "Vancouver",
    "SanJose",
    "RandomIsland",
    "Perth",
    "KansasCity",
    "RioDeJaneiro",
    "TestGround",
    "Istanbul",
    "Auckland",
] as const;

const DEFAULT_MAP = "Stockholm";
/** `byValuationPerHourNewPlayers`: maps created within this window count as "new players" */
export const NEW_PLAYER_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ROWS = 100;

export interface TickInput {
    userId: string;
    userName: string;
    flag: string;
    dlc: number;
    map: string;
    mapCreatedAt: number;
    cash: number;
    resourceValuation: number;
    resourceValuationForReference: number;
    buildingValuation: number;
    buildingCount: number;
    prestigeCurrency: number;
    allPrestigeCurrency: number;
    optOut: boolean;
}

/** Ingest one `tick` message; maintains the EMA of valuation/hour. */
export function ingestTick(db: Db, tick: TickInput, now = Date.now()): TickSnapshot {
    const valuation = (tick.resourceValuation || 0) + (tick.buildingValuation || 0);
    const prev = db.snapshots[tick.userId];
    let valuationPerHour = prev?.valuationPerHour ?? 0;
    if (prev) {
        const dt = now - prev.updatedAt;
        if (dt > 0) {
            const rate = Math.max(0, (valuation - prev.valuation) / (dt / 3_600_000));
            // EMA weighted by elapsed time, ~1h time constant
            const alpha = Math.min(1, dt / 3_600_000);
            valuationPerHour = prev.valuationPerHour + (rate - prev.valuationPerHour) * alpha;
        }
    }
    const snapshot: TickSnapshot = {
        userId: tick.userId,
        userName: tick.userName,
        flag: tick.flag,
        dlc: tick.dlc,
        map: tick.map,
        mapCreatedAt: tick.mapCreatedAt,
        cash: tick.cash,
        resourceValuation: tick.resourceValuation,
        resourceValuationForReference: tick.resourceValuationForReference,
        buildingValuation: tick.buildingValuation,
        buildingCount: tick.buildingCount,
        prestigeCurrency: tick.prestigeCurrency,
        allPrestigeCurrency: tick.allPrestigeCurrency,
        optOut: !!tick.optOut,
        valuation,
        valuationPerHour,
        updatedAt: now,
    };
    db.snapshots[tick.userId] = snapshot;
    return snapshot;
}

function visiblePlayers(db: Db): TickSnapshot[] {
    return Object.values(db.snapshots).filter((p) => !p.optOut);
}

function safeMap(map: string): string {
    return (KNOWN_MAPS as readonly string[]).includes(map) ? map : DEFAULT_MAP;
}

type Row = (number | string)[];

function ranked(
    players: TickSnapshot[],
    value: (p: TickSnapshot) => number,
    limit = MAX_ROWS
): Row[] {
    return players
        .map((p): Row => [value(p), p.userName, p.dlc, p.flag, safeMap(p.map)])
        .sort((a, b) => (b[0] as number) - (a[0] as number))
        .slice(0, limit);
}

/**
 * Compute a board. Unknown board names return an empty dataset (the client just renders an empty table).
 */
export function computeBoard(db: Db, name: string): { data: Row[]; updatedAt: number } {
    const players = visiblePlayers(db);
    let data: Row[] = [];
    if (name === "byAllPrestigeCurrency") {
        data = ranked(players, (p) => p.allPrestigeCurrency);
    } else if (name === "byValuationPerHour") {
        data = ranked(players, (p) => p.valuationPerHour);
    } else if (name === "byCash") {
        data = ranked(players, (p) => p.cash);
    } else if (name === "byValuation") {
        data = ranked(players, (p) => p.valuation);
    } else if (name === "byValuationPerBuilding") {
        data = ranked(players, (p) => p.valuation / Math.max(1, p.buildingCount));
    } else if (name === "byValuationPerHourPerSwiss") {
        data = ranked(players.filter((p) => p.allPrestigeCurrency > 0), (p) => p.valuationPerHour / p.allPrestigeCurrency);
    } else if (name === "byValuationPerHourNewPlayers") {
        const cutoff = Date.now() - NEW_PLAYER_WINDOW_MS;
        data = ranked(players.filter((p) => p.mapCreatedAt >= cutoff), (p) => p.valuationPerHour);
    } else if (name === "byFlag") {
        data = group(players, (p) => p.flag);
    } else if (name === "byMap") {
        data = group(players, (p) => safeMap(p.map));
    } else if (name.startsWith("byValuation")) {
        // per-map boards: `byValuation<MapKey>` = valuation per hour on that map
        const map = name.slice("byValuation".length);
        data = ranked(players.filter((p) => safeMap(p.map) === map), (p) => p.valuationPerHour);
    }
    return { data, updatedAt: Date.now() };
}

/** `byFlag` / `byMap`: `[key, playerCount, ΣvaluationPerHour, ΣallPrestigeCurrency]`, sorted by ΣvaluationPerHour */
function group(players: TickSnapshot[], key: (p: TickSnapshot) => string): Row[] {
    const groups = new Map<string, { count: number; perHour: number; swiss: number }>();
    for (const p of players) {
        const k = key(p);
        const g = groups.get(k) ?? { count: 0, perHour: 0, swiss: 0 };
        g.count += 1;
        g.perHour += p.valuationPerHour;
        g.swiss += p.allPrestigeCurrency;
        groups.set(k, g);
    }
    return [...groups.entries()]
        .map(([k, g]): Row => [k, g.count, g.perHour, g.swiss])
        .sort((a, b) => (b[2] as number) - (a[2] as number))
        .slice(0, MAX_ROWS);
}
