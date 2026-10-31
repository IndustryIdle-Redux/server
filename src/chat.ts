/**
 * Chat service — per-channel history, rate limiting and ip mutes.
 *
 * Wire format matches `IChatMessage` in `src/net/Socket.ts`. The client renders
 * `user` / `message` / `dlc` / `flag` / `time`, and only **moderator** clients get
 * the `ip` field (it drives the mute UI in `ChatPage.ts`), so the wire formatting
 * is done per recipient in `ws.ts`.
 */

import type { ServerConfig } from "./config";
import type { ChatRecord, Store, UserRecord } from "./store";
import { clampString, sanitizeChannel } from "./validation";

export const DEFAULT_CHANNEL = "en";

export class ChatService {
    private readonly lastSendAt = new Map<string, number>();

    constructor(
        private readonly store: Store,
        private readonly config: ServerConfig
    ) {}

    public isMuted(ip: string, now = Date.now()): boolean {
        const until = this.store.db.mutes[ip];
        return !!until && until > now;
    }

    /** mute (timeMs > 0) or unmute (timeMs === 0) an ip */
    public mute(ip: string, timeMs: number): void {
        if (timeMs > 0) {
            this.store.db.mutes[ip] = Date.now() + timeMs;
        } else {
            delete this.store.db.mutes[ip];
        }
        this.store.markDirty();
    }

    public history(channel: string, limit = 100): ChatRecord[] {
        const list = this.store.db.chat[channel] ?? [];
        return list.slice(Math.max(0, list.length - limit));
    }

    /**
     * Handle one incoming `chat` message.
     * Returns the stored record, or an error string.
     */
    public handleChat(user: UserRecord, msg: { message?: unknown; channel?: unknown }, now = Date.now()): ChatRecord | string {
        const message = clampString(msg.message, 500);
        const channel = sanitizeChannel(msg.channel, DEFAULT_CHANNEL);
        if (!message) return "empty message";
        if (message.length > 500) return "message too long";
        if (this.isMuted(user.ip, now)) return "you are muted";
        const last = this.lastSendAt.get(user.userId) ?? 0;
        if (now - last < this.config.chatRateLimitMs) {
            return "slow down";
        }
        this.lastSendAt.set(user.userId, now);

        const record: ChatRecord = {
            user: user.userName,
            userId: user.userId,
            message,
            dlc: user.dlc,
            flag: user.flag,
            channel,
            time: now,
            ip: user.ip,
        };
        const list = (this.store.db.chat[channel] ??= []);
        list.push(record);
        if (list.length > this.config.chatHistorySize) {
            list.splice(0, list.length - this.config.chatHistorySize);
        }
        this.store.markDirty();
        return record;
    }
}
