import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Store, type ChatRecord, type TickSnapshot, type TradeRecord, type UserRecord } from "../src/store";

function tmpDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "ii-store-"));
}

function user(id: string): UserRecord {
    return {
        userId: id,
        tradeToken: `${id}-token`,
        userName: id.toUpperCase(),
        flag: "earth",
        dlc: 0,
        authenticated: true,
        createdAt: 1,
        lastSeenAt: 2,
        ip: "127.0.0.1",
        platform: "web",
        version: "test",
    };
}

function trade(id: string, status: TradeRecord["status"]): TradeRecord {
    return {
        id,
        type: "trade",
        side: "sell",
        resource: "Fe",
        amount: 10,
        price: 2,
        from: "ALICE",
        fromUserHash: "deadbeef",
        fromUserId: "alice",
        fillBy: null,
        filledByUserId: null,
        status,
        createdAt: 100,
        openedAt: 101,
        filledAt: null,
        closedAt: status === "closed" ? 102 : null,
    };
}

function snapshot(userId: string): TickSnapshot {
    return {
        userId,
        userName: "ALICE",
        flag: "earth",
        dlc: 0,
        map: "Stockholm",
        mapCreatedAt: 1,
        cash: 10,
        resourceValuation: 20,
        resourceValuationForReference: 3,
        buildingValuation: 30,
        buildingCount: 4,
        prestigeCurrency: 5,
        allPrestigeCurrency: 6,
        optOut: false,
        valuation: 50,
        valuationPerHour: 60,
        updatedAt: 200,
    };
}

function chatRecord(channel: string, message: string): ChatRecord {
    return { user: "ALICE", userId: "alice", message, dlc: 0, flag: "earth", channel, time: 300, ip: "127.0.0.1" };
}

describe("SQLite store", () => {
    it("writes every collection and reloads it", () => {
        const dir = tmpDir();
        const store = new Store(dir);
        store.db.users.alice = user("alice");
        store.db.tokens["alice-token"] = "alice";
        store.db.trades.t1 = trade("t1", "open");
        store.db.history.push(trade("h1", "closed"));
        store.db.chat.en = [chatRecord("en", "hello"), chatRecord("en", "world")];
        store.db.pledges["project.1"] = 1234;
        store.db.mutes["1.2.3.4"] = 9999;
        store.db.snapshots.alice = snapshot("alice");
        store.db.streams.alice = { userId: "alice", token: "stream-token", user: { name: "ALICE", dlc: 0, flag: "earth" }, since: 400 };
        store.saveUser(store.db.users.alice);
        store.saveToken("alice-token", "alice");
        store.saveTrade(store.db.trades.t1);
        store.appendHistory(store.db.history[0]);
        store.saveChatChannel("en");
        store.savePledge("project.1");
        store.saveMute("1.2.3.4");
        store.saveSnapshot(store.db.snapshots.alice);
        store.saveStream(store.db.streams.alice);
        store.close();

        expect(fs.existsSync(path.join(dir, "db.sqlite"))).toBe(true);
        const reopened = new Store(dir);
        expect(reopened.db.users.alice).toMatchObject({ userName: "ALICE", tradeToken: "alice-token", authenticated: true });
        expect(reopened.db.tokens["alice-token"]).toBe("alice");
        expect(reopened.db.trades.t1).toMatchObject({ status: "open", amount: 10, openedAt: 101 });
        expect(reopened.db.history.map((h) => h.id)).toEqual(["h1"]);
        expect(reopened.db.chat.en.map((m) => m.message)).toEqual(["hello", "world"]);
        expect(reopened.db.pledges["project.1"]).toBe(1234);
        expect(reopened.db.mutes["1.2.3.4"]).toBe(9999);
        expect(reopened.db.snapshots.alice).toMatchObject({ valuation: 50, valuationPerHour: 60, optOut: false });
        expect(reopened.db.streams.alice).toMatchObject({ token: "stream-token", user: { name: "ALICE" } });
        reopened.close();
    });

    it("applies deletions, channel replacement and history pruning", () => {
        const dir = tmpDir();
        const store = new Store(dir);
        store.db.users.alice = user("alice");
        store.db.tokens["alice-token"] = "alice";
        store.db.tokens["old-token"] = "alice";
        store.db.trades.t1 = trade("t1", "open");
        store.db.history.push(trade("h1", "closed"), trade("h2", "closed"));
        store.db.chat.en = [chatRecord("en", "first"), chatRecord("en", "second")];
        store.db.mutes["1.2.3.4"] = 9999;
        store.db.streams.alice = { userId: "alice", token: "s", user: { name: "ALICE", dlc: 0, flag: "earth" }, since: 1 };
        store.saveUser(store.db.users.alice);
        store.saveToken("alice-token", "alice");
        store.saveToken("old-token", "alice");
        store.saveTrade(store.db.trades.t1);
        store.appendHistory(store.db.history[0]);
        store.appendHistory(store.db.history[1]);
        store.saveChatChannel("en");
        store.saveMute("1.2.3.4");
        store.saveStream(store.db.streams.alice);
        store.flushSync();

        // now mutate + persist removals
        delete store.db.tokens["old-token"];
        store.deleteToken("old-token");
        delete store.db.trades.t1;
        store.deleteTrade("t1");
        store.db.chat.en = [chatRecord("en", "second")];
        store.saveChatChannel("en");
        delete store.db.mutes["1.2.3.4"];
        store.deleteMute("1.2.3.4");
        delete store.db.streams.alice;
        store.deleteStream("alice");
        store.pruneHistory(1);
        store.close();

        const reopened = new Store(dir);
        expect(reopened.db.tokens["old-token"]).toBeUndefined();
        expect(reopened.db.trades.t1).toBeUndefined();
        expect(reopened.db.chat.en.map((m) => m.message)).toEqual(["second"]);
        expect(reopened.db.mutes["1.2.3.4"]).toBeUndefined();
        expect(reopened.db.streams.alice).toBeUndefined();
        expect(reopened.db.history.map((h) => h.id)).toEqual(["h2"]);
        reopened.close();
    });

    it("flushes a queued change on shutdown", () => {
        const dir = tmpDir();
        const store = new Store(dir);
        store.db.users.alice = user("alice");
        store.saveUser(store.db.users.alice);
        // no explicit flush: close() must write the pending row
        store.close();
        const reopened = new Store(dir);
        expect(reopened.db.users.alice).toBeDefined();
        reopened.close();
    });
});
