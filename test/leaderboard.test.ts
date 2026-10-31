/** Leaderboard metric + row-shape tests (row shapes must match `LeaderboardPage.ts`). */

import { describe, expect, it } from "vitest";
import { computeBoard, ingestTick, NEW_PLAYER_WINDOW_MS, type TickInput } from "../src/leaderboard";
import type { Db } from "../src/store";

function emptyDb(): Db {
    return { users: {}, tokens: {}, trades: {}, history: [], chat: {}, pledges: {}, mutes: {}, snapshots: {}, streams: {} };
}

function tick(userId: string, over: Partial<TickInput> = {}): TickInput {
    return {
        userId,
        userName: userId.toUpperCase(),
        flag: "earth",
        dlc: 0,
        map: "Stockholm",
        mapCreatedAt: Date.now() - 24 * 60 * 60 * 1000,
        cash: 1000,
        resourceValuation: 5000,
        resourceValuationForReference: 5000,
        buildingValuation: 2000,
        buildingCount: 10,
        prestigeCurrency: 1,
        allPrestigeCurrency: 10,
        optOut: false,
        ...over,
    };
}

describe("ingestTick", () => {
    it("valuation = resourceValuation + buildingValuation (client getValuation)", () => {
        const db = emptyDb();
        const s = ingestTick(db, tick("u1"));
        expect(s.valuation).toBe(7000);
    });

    it("tracks valuation/hour as an EMA over tick deltas", () => {
        const db = emptyDb();
        const t0 = 1_700_000_000_000;
        ingestTick(db, tick("u1", { resourceValuation: 0 }), t0);
        // +3600 valuation over 1h → 3600/hour
        const s2 = ingestTick(db, tick("u1", { resourceValuation: 3600 }), t0 + 3_600_000);
        expect(s2.valuationPerHour).toBeCloseTo(3600, 5);
    });

    it("never goes negative (prestige resets are not penalised)", () => {
        const db = emptyDb();
        const t0 = 1_700_000_000_000;
        ingestTick(db, tick("u1", { resourceValuation: 1e6 }), t0);
        const s2 = ingestTick(db, tick("u1", { resourceValuation: 0 }), t0 + 60_000);
        expect(s2.valuationPerHour).toBe(0);
    });

    it("keeps the last tick per user", () => {
        const db = emptyDb();
        ingestTick(db, tick("u1", { cash: 1 }), 1000);
        ingestTick(db, tick("u1", { cash: 2 }), 2000);
        expect(db.snapshots.u1.cash).toBe(2);
    });
});

describe("computeBoard", () => {
    function seededDb(): Db {
        const db = emptyDb();
        const t0 = Date.now() - 60_000;
        ingestTick(db, tick("u1", { userName: "ALICE", cash: 100, allPrestigeCurrency: 5, dlc: 2, flag: "de", map: "Oslo" }), t0);
        ingestTick(db, tick("u2", { userName: "BOB", cash: 900, allPrestigeCurrency: 1, dlc: 0, flag: "us", map: "Rome" }), t0);
        ingestTick(db, tick("u3", { userName: "CAROL", optOut: true, cash: 99999 }), t0);
        return db;
    }

    it("normal boards return [value, name, dlc, flag, map] rows sorted by value", () => {
        const { data } = computeBoard(seededDb(), "byCash");
        expect(data).toHaveLength(2); // opt-out player excluded
        expect(data[0]).toEqual([900, "BOB", 0, "us", "Rome"]);
        expect(data[1]).toEqual([100, "ALICE", 2, "de", "Oslo"]);
    });

    it("always emits a valid MAP key (the client renders MAP[item[4]].name())", () => {
        const db = emptyDb();
        ingestTick(db, tick("u1", { map: "NotARealMap" }));
        const { data } = computeBoard(db, "byCash");
        expect(data[0][4]).toBe("Stockholm");
    });

    it("byValuation uses resourceValuation + buildingValuation", () => {
        const db = emptyDb();
        ingestTick(db, tick("u1", { resourceValuation: 100, buildingValuation: 50 }));
        expect(computeBoard(db, "byValuation").data[0][0]).toBe(150);
    });

    it("byValuationPerBuilding divides by building count", () => {
        const db = emptyDb();
        ingestTick(db, tick("u1", { resourceValuation: 100, buildingValuation: 50, buildingCount: 3 }));
        expect(computeBoard(db, "byValuationPerBuilding").data[0][0]).toBe(50);
    });

    it("byValuationPerHourPerSwiss only ranks players with swiss money", () => {
        const db = emptyDb();
        ingestTick(db, tick("u1", { allPrestigeCurrency: 0 }));
        ingestTick(db, tick("u2", { allPrestigeCurrency: 10 }));
        expect(computeBoard(db, "byValuationPerHourPerSwiss").data).toHaveLength(1);
    });

    it("byValuationPerHourNewPlayers filters by map age", () => {
        const db = emptyDb();
        ingestTick(db, tick("old", { mapCreatedAt: Date.now() - NEW_PLAYER_WINDOW_MS * 2 }));
        ingestTick(db, tick("new", { mapCreatedAt: Date.now() - 1000 }));
        const { data } = computeBoard(db, "byValuationPerHourNewPlayers");
        expect(data).toHaveLength(1);
        expect(data[0][1]).toBe("NEW");
    });

    it("byFlag / byMap return [key, count, ΣperHour, Σswiss] rows", () => {
        const db = emptyDb();
        ingestTick(db, tick("u1", { flag: "de", map: "Oslo", allPrestigeCurrency: 3 }));
        ingestTick(db, tick("u2", { flag: "de", map: "Rome", allPrestigeCurrency: 4 }));
        const byFlag = computeBoard(db, "byFlag").data;
        expect(byFlag[0][0]).toBe("de");
        expect(byFlag[0][1]).toBe(2);
        expect(byFlag[0][3]).toBe(7);
        const byMap = computeBoard(db, "byMap").data;
        expect(byMap).toHaveLength(2);
    });

    it("per-map boards (byValuation<Map>) filter to that map", () => {
        const db = emptyDb();
        ingestTick(db, tick("u1", { map: "Oslo" }));
        ingestTick(db, tick("u2", { map: "Rome" }));
        expect(computeBoard(db, "byValuationOslo").data).toHaveLength(1);
    });

    it("unknown boards return empty data", () => {
        expect(computeBoard(seededDb(), "byNope").data).toEqual([]);
    });

    it("responses always carry updatedAt", () => {
        const r = computeBoard(seededDb(), "byCash");
        expect(r.updatedAt).toBeGreaterThan(0);
    });
});
