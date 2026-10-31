/**
 * Wire protocol types — mirrored 1:1 from the client side:
 *
 * | client source | type |
 * |---|---|
 * | `src/net/Socket.ts` `IMessage` / `IChatMessage` / `ITradeMessage` / `IPledge*` / `ISignalMessage` / `ITradeFine` | envelope + chat / trade / pledge / signal / fines |
 * | `src/features/market/PlayerTrade.ts` `ITrade` / `ILocalTrade` / `ITradeRequest` | trade records |
 * | `src/ui/pages/PlayerTradeHistoryPage.ts` `IHistoricalTrade` | trade history rows |
 * | `src/ui/shell/ImportExport.ts` `VerificationResult` | `/user/verification` response |
 */

export type MessageType =
    | "join"
    | "chat"
    | "trade"
    | "tick"
    | "logout"
    | "pledge"
    | "export"
    | "signal"
    | "streaming"
    | "tradeFine";

/** Every server→client message carries `time` (server clock) and `isMod` (the client resets its mod flag on every message that lacks it!) */
export interface IEnvelope {
    type: MessageType;
    id?: string;
    time?: number;
    auth?: boolean;
    isMod?: boolean;
    [k: string]: unknown;
}

export interface IChatMessage extends IEnvelope {
    type: "chat";
    user: string;
    message: string;
    dlc: number;
    flag: string;
    channel: string;
    /** only sent to moderator clients (used by the mute UI) */
    ip?: string;
}

export interface IJoinMessage extends IEnvelope {
    type: "join";
    messages: IChatMessage[];
}

export type OrderStatus = "open" | "filled" | "closed" | "cancelled";
export type OrderSide = "buy" | "sell";

/** What the client keeps in `Socket.activeTrades` (the public order book) */
export interface ITrade {
    id: string;
    from: string;
    fromUserHash: string;
    side: OrderSide;
    resource: string;
    amount: number;
    price: number;
    fillBy: string | null;
    status: OrderStatus;
}

/** What the client keeps in `Socket.myTrades` (my own orders, open or filled-but-unclaimed) */
export interface ILocalTrade extends ITrade {
    type: "trade";
    fromUserId: string;
    createdAt: number;
}

/** Full trade message as signed by `signTrade` (extra fields vary by lifecycle step) */
export interface ITradeRequest extends ITrade {
    type: "trade";
    sig: string;
    token: string;
    fromUserId?: string;
    createdAt?: number;
}

export interface ITradeMessage extends IEnvelope {
    type: "trade";
    flush?: Record<string, ITrade>;
    add?: Record<string, ITrade>;
    delete?: Record<string, Record<string, never>>;
    myTrades?: Record<string, ILocalTrade>;
    error?: string;
    id?: string;
    token?: string;
}

export interface IPledge {
    resource: string;
    index: number;
    amount: number;
}

export interface IPledgeMessage extends IEnvelope {
    type: "pledge";
    pledge: Record<string, IPledge[]>;
}

export interface IPledgeResponse extends IEnvelope {
    type: "pledge";
    pledge: Record<string, number>;
}

export interface IStreamingUser {
    name: string;
    dlc: number;
    flag: string;
}

export interface IStreamingMessage extends IEnvelope {
    type: "streaming";
    users?: Record<string, IStreamingUser>;
    token?: string;
}

export interface ITradeFine {
    playerName: string;
    numberOfTrades: number;
    profit: number;
}

export interface ITradeFineMessage extends IEnvelope {
    type: "tradeFine";
    fines: ITradeFine[];
}

/** `/user/verification` response (see `VerificationResult` in ImportExport.ts) */
export interface IVerificationResult {
    authenticated: boolean;
    rightToTrade: boolean;
    rightToTradeCooldown: number;
    trusted: boolean;
    passAntiCheat: boolean;
    passPlatformIdCheck: boolean;
}

/** One row of `GET /leaderboard/v4` for the "normal" boards: `[value, name, dlc, flag, map]` */
export type ILeaderboardRow = [number, string, number, string, string];
/** Rows for `byFlag` / `byMap`: `[flag|map, playerCount, valuationPerHour, swissMoney]` */
export type ILeaderboardGroupRow = [string, number, number, number];

export interface ILeaderboardResponse {
    data: (ILeaderboardRow | ILeaderboardGroupRow)[];
    updatedAt: number;
}
