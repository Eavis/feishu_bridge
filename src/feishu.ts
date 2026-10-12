/**
 * Feishu Client — WebSocket event subscription + REST message sending.
 *
 * Uses @larksuiteoapi/node-sdk WSClient for real-time events and REST Client
 * for message operations. Renders responses via CardKit v2 streaming cards
 * with 3-layer send degradation (card → post → text).
 *
 * Card action callbacks require a WSClient monkey-patch because the SDK's
 * WSClient only handles type="event" messages; card callbacks arrive as
 * type="card" and would be silently dropped without the patch.
 */

import crypto from 'node:crypto';
import * as lark from '@larksuiteoapi/node-sdk';
import type {
  InboundMessage,
  FileAttachment,
  ToolCallInfo,
  TokenUsage,
  AppContext,
} from './types.js';
import type { WsConnectionHealth } from './ws-health.js';
import { createFeishuHttpClient } from './feishu-http.js';
import {
  htmlToFeishuMarkdown,
  preprocessFeishuMarkdown,
  hasComplexMarkdown,
  buildCardContent,
  buildPostContent,
  buildStreamingContent,
  buildFinalCardJson,
  buildPermissionButtonCard,
  buildCronConfirmCard,
  buildStreamingCardInitJson,
  formatElapsed,
  formatTokenCount,
} from './feishu-markdown.js';

const DEDUP_MAX = 1000;
const MAX_FILE_SIZE = 20 * 1024 * 1024;
const TYPING_EMOJI = 'Typing';
const CARD_THROTTLE_MS = 200;

// Feishu card content has a hard size limit (~30KB); pushing more makes both the
// streaming-element update and the final card.update fail with 99992402
// "field validation failed", which leaves the card stuck in streaming mode (the
// Stop button never disappears — looks frozen). We cap the text rendered into
// cards well under that. The bridge delivers the full/untruncated response
// separately (chunked plain text) so nothing is lost.
export const CARD_TEXT_BYTE_BUDGET = 18000;
function capUtf8(s: string, maxBytes: number, tail = false): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  const slice = tail ? buf.subarray(buf.length - maxBytes) : buf.subarray(0, maxBytes);
  // Buffer.toString tolerates a partial multibyte char at the cut edge.
  return slice.toString('utf8');
}

/** State for an active CardKit v2 streaming card. */
interface CardState {
  cardId: string;
  messageId: string;
  sequence: number;
  startTime: number;
  toolCalls: ToolCallInfo[];
  thinking: boolean;
  pendingText: string | null;
  lastUpdateAt: number;
  throttleTimer: ReturnType<typeof setTimeout> | null;
  /** When a retry happens, this banner is prepended to the card body and survives final-card finalize. */
  retryBanner?: string | null;
}

type FeishuMessageEventData = {
  sender: {
    sender_id?: {
      open_id?: string;
      union_id?: string;
      user_id?: string;
    };
    sender_type: string;
    tenant_key?: string;
  };
  message: {
    message_id: string;
    /** When user uses Feishu's "reply" / "quote" UI, this is the message_id of the original message. */
    parent_id?: string;
    /** Root of the quote chain (if quote-of-quote). */
    root_id?: string;
    chat_id: string;
    chat_type: string;
    message_type: string;
    content: string;
    create_time: string;
    mentions?: Array<{
      key: string;
      id: { open_id?: string; union_id?: string; user_id?: string };
      name: string;
    }>;
  };
};

const MIME_BY_TYPE: Record<string, string> = {
  image: 'image/png',
  file: 'application/octet-stream',
  audio: 'audio/ogg',
  video: 'video/mp4',
  media: 'application/octet-stream',
};

const RETRY_REASON_LABELS: Record<string, string> = {
  usage_policy: 'Usage Policy 拦截',
  rate_limit: '触发限流',
  server_5xx: 'Anthropic 服务端错误',
  network: '网络错误',
};

function retryReasonLabel(reason: string): string {
  return RETRY_REASON_LABELS[reason] || `重试 (${reason})`;
}

export interface SendResult {
  ok: boolean;
  messageId?: string;
  error?: string;
}

export class FeishuClient {
  private config: AppContext['config'];
  private running = false;
  private queue: InboundMessage[] = [];
  private waiters: Array<(msg: InboundMessage | null) => void> = [];
  private wsClient: lark.WSClient | null = null;
  private restClient: lark.Client | null = null;
  private seenMessageIds = new Map<string, boolean>();
  private botOpenId: string | null = null;
  private botIds = new Set<string>();
  private lastIncomingMessageId = new Map<string, string>();
  private typingReactions = new Map<string, string>();
  private activeCards = new Map<string, CardState>();
  private cardCreatePromises = new Map<string, Promise<boolean>>();
  private lastInboundEventAt: number | null = null;

  constructor(config: AppContext['config']) {
    this.config = config;
  }

  // ── Lifecycle ───────────────────────────────────────────────

  async start(): Promise<void> {
    if (this.running) return;

    const { feishuAppId, feishuAppSecret, feishuDomain } = this.config;
    if (!feishuAppId || !feishuAppSecret) {
      console.warn('[feishu] Cannot start: missing appId or appSecret');
      return;
    }

    const domain = feishuDomain === 'lark'
      ? lark.Domain.Lark
      : lark.Domain.Feishu;

    this.restClient = new lark.Client({
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      domain,
    });

    await this.resolveBotIdentity(feishuAppId, feishuAppSecret, domain);

    this.running = true;

    const dispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data) => {
        await this.handleIncomingEvent(data as FeishuMessageEventData);
      },
      'card.action.trigger': (async (data: unknown) => {
        console.log('[feishu] card.action.trigger fired, raw=', JSON.stringify(data).slice(0, 600));
        return await this.handleCardAction(data);
      }) as any,
    });

    // Probe: log every event the dispatcher tries to handle, even unregistered
    // ones. The SDK sometimes emits events with names we don't know yet.
    const dispAny = dispatcher as any;
    if (typeof dispAny.invoke === 'function') {
      const origInvoke = dispAny.invoke.bind(dispAny);
      dispAny.invoke = function (...args: any[]) {
        try {
          const eventName = args[0]?.header?.event_type
            || args[0]?.event_type
            || args[0]?.type
            || (typeof args[0] === 'string' ? args[0] : '');
          console.log('[feishu] dispatcher.invoke event=', eventName, 'argKeys=', Object.keys(args[0] || {}).join(','));
        } catch { /* probe only */ }
        return origInvoke(...args);
      };
    }

    this.wsClient = new lark.WSClient({
      appId: feishuAppId,
      appSecret: feishuAppSecret,
      domain,
      httpInstance: createFeishuHttpClient(this.config.feishuRequestTimeoutMs),
      autoReconnect: true,
      handshakeTimeoutMs: 20_000,
      // Disabled by default in the SDK. Enable it so a half-open TCP socket
      // is terminated when a ping receives no pong/inbound frame.
      wsConfig: { pingTimeout: 15 },
      onReady: () => console.log('[feishu] WebSocket lifecycle: ready'),
      onReconnecting: () => console.warn('[feishu] WebSocket lifecycle: reconnecting'),
      onReconnected: () => console.log('[feishu] WebSocket lifecycle: reconnected'),
      onError: (err: Error) => console.error('[feishu] WebSocket lifecycle: failed:', err.message),
    });

    // Monkey-patch WSClient.handleEventData to support card action events.
    // The SDK's WSClient only processes type="event" messages. Card action
    // callbacks arrive as type="card" and would be silently dropped.
    const wsAny = this.wsClient as any;
    console.log('[feishu] WSClient prototype keys:', Object.getOwnPropertyNames(Object.getPrototypeOf(wsAny || {})).join(','));
    if (typeof wsAny.handleEventData === 'function') {
      const origHandleEventData = wsAny.handleEventData.bind(wsAny);
      wsAny.handleEventData = (data: any) => {
        this.lastInboundEventAt = Date.now();
        const msgType = data.headers?.find?.((h: any) => h.key === 'type')?.value;
        // Dump everything once per event so we can see what type Feishu sends for button clicks
        const allHeaders: Record<string, any> = {};
        for (const h of (data.headers || [])) allHeaders[h.key] = h.value;
        console.log('[feishu] handleEventData fired: msgType=', msgType, 'allHeaders=', JSON.stringify(allHeaders).slice(0, 500));
        if (data.payload) {
          try {
            const payloadStr = Buffer.isBuffer(data.payload) ? data.payload.toString('utf-8') : String(data.payload);
            console.log('[feishu] handleEventData payload=', payloadStr.slice(0, 500));
          } catch { /* */ }
        }
        if (msgType === 'card') {
          console.log('[feishu] handleEventData type: card (patched → event)');
          const patchedData = {
            ...data,
            headers: data.headers.map((h: any) =>
              h.key === 'type' ? { ...h, value: 'event' } : h,
            ),
          };
          return origHandleEventData(patchedData);
        }
        return origHandleEventData(data);
      };
    } else {
      console.warn('[feishu] WSClient.handleEventData not found — monkey patch SKIPPED. Card buttons will NOT work.');
    }

    this.wsClient.start({ eventDispatcher: dispatcher });
    console.log('[feishu] Started (botOpenId:', this.botOpenId || 'unknown', ')');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;

    if (this.wsClient) {
      try { this.wsClient.close({ force: true }); } catch { /* ignore */ }
      this.wsClient = null;
    }
    this.restClient = null;

    for (const waiter of this.waiters) {
      waiter(null);
    }
    this.waiters = [];

    for (const [, state] of this.activeCards) {
      if (state.throttleTimer) clearTimeout(state.throttleTimer);
    }
    this.activeCards.clear();
    this.cardCreatePromises.clear();
    this.seenMessageIds.clear();
    this.lastIncomingMessageId.clear();
    this.typingReactions.clear();

    console.log('[feishu] Stopped');
  }

  isRunning(): boolean {
    return this.running;
  }

  // ── Queue ───────────────────────────────────────────────────

  consumeOne(): Promise<InboundMessage | null> {
    const queued = this.queue.shift();
    if (queued) return Promise.resolve(queued);
    if (!this.running) return Promise.resolve(null);
    return new Promise<InboundMessage | null>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private enqueue(msg: InboundMessage): void {
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter(msg);
    } else {
      this.queue.push(msg);
    }
  }

  /**
   * Inject a synthetic inbound message (e.g. from the scheduler). Bypasses
   * authorization and dedup checks because the source is trusted local code,
   * not a real Feishu event.
   */
  injectInboundMessage(msg: InboundMessage): void {
    this.enqueue(msg);
    // Only track lastIncomingMessageId if it's a real Feishu message_id.
    // Scheduler-injected messages pass empty string to avoid polluting the
    // reply target (which would later trigger im.message.reply with a fake id).
    if (msg.chatId && msg.messageId) {
      this.lastIncomingMessageId.set(msg.chatId, msg.messageId);
    }
  }

  // ── Typing indicator ───────────────────────────────────────

  onMessageStart(chatId: string, sessionId: string): void {
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (messageId) {
      this.createStreamingCard(chatId, sessionId, messageId).catch(() => {});
    }
    if (!messageId || !this.restClient) return;
    this.restClient.im.messageReaction.create({
      path: { message_id: messageId },
      data: { reaction_type: { emoji_type: TYPING_EMOJI } },
    }).then((res) => {
      const reactionId = (res as any)?.data?.reaction_id;
      if (reactionId) {
        this.typingReactions.set(chatId, reactionId);
      }
    }).catch((err) => {
      const code = (err as { code?: number })?.code;
      if (code !== 99991400 && code !== 99991403) {
        console.warn('[feishu] Typing indicator failed:', err instanceof Error ? err.message : err);
      }
    });
  }

  onMessageEnd(chatId: string): void {
    this.cleanupCard(chatId);
    const reactionId = this.typingReactions.get(chatId);
    const messageId = this.lastIncomingMessageId.get(chatId);
    if (!reactionId || !messageId || !this.restClient) return;
    this.typingReactions.delete(chatId);
    this.restClient.im.messageReaction.delete({
      path: { message_id: messageId, reaction_id: reactionId },
    }).catch(() => { /* ignore */ });
  }

  // ── Card Action Handler ────────────────────────────────────

  private async handleCardAction(data: unknown): Promise<unknown> {
    const FALLBACK_TOAST = { toast: { type: 'info' as const, content: '已收到' } };
    try {
      const event = data as any;
      // Dump shape on first action — invaluable when SDK / Feishu schema changes.
      const evtKeys = Object.keys(event || {}).join(',');
      const actionKeys = Object.keys(event?.action || {}).join(',');
      console.log('[feishu] card action raw: evtKeys=', evtKeys, 'actionKeys=', actionKeys);

      // Try several paths the value can live at across schema 1.0/2.0 + WS payloads
      const value = event?.action?.value
        ?? event?.event?.action?.value
        ?? event?.action?.form_value
        ?? {};
      const callbackData = value.callback_data
        ?? event?.action?.name   // schema 2.0 sometimes uses `name`
        ?? '';
      console.log('[feishu] card action: value=', JSON.stringify(value).slice(0, 200), 'callbackData=', callbackData);

      if (!callbackData) {
        console.warn('[feishu] card action: no callback_data found, dropping');
        return FALLBACK_TOAST;
      }

      const chatId = event?.context?.open_chat_id
        ?? event?.event?.context?.open_chat_id
        ?? value.chatId
        ?? '';
      const messageId = event?.context?.open_message_id
        ?? event?.event?.context?.open_message_id
        ?? event?.open_message_id
        ?? '';
      const userId = event?.operator?.open_id
        ?? event?.event?.operator?.open_id
        ?? event?.open_id
        ?? '';
      if (!chatId) {
        console.warn('[feishu] card action: missing chatId');
        return FALLBACK_TOAST;
      }

      this.enqueue({
        messageId: messageId || `card_action_${Date.now()}`,
        chatId,
        userId,
        text: '',
        timestamp: Date.now(),
        callbackData,
        callbackMessageId: messageId,
      });
      console.log('[feishu] card action enqueued: callbackData=', callbackData, 'chatId=', chatId);

      return { toast: { type: 'info' as const, content: '已收到，正在处理...' } };
    } catch (err) {
      console.error('[feishu] Card action error:', err instanceof Error ? err.message : err);
      return FALLBACK_TOAST;
    }
  }

  // ── Streaming Card (CardKit v2) ────────────────────────────

  private createStreamingCard(chatId: string, sessionId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient || this.activeCards.has(chatId)) return Promise.resolve(false);
    const existing = this.cardCreatePromises.get(chatId);
    if (existing) return existing;

    const promise = this._doCreateStreamingCard(chatId, sessionId, replyToMessageId);
    this.cardCreatePromises.set(chatId, promise);
    promise.finally(() => this.cardCreatePromises.delete(chatId));
    return promise;
  }

  private async _doCreateStreamingCard(chatId: string, sessionId: string, replyToMessageId?: string): Promise<boolean> {
    if (!this.restClient) return false;

    try {
      const cardJson = buildStreamingCardInitJson(sessionId);

      const createResp = await (this.restClient as any).cardkit.v1.card.create({
        data: { type: 'card_json', data: cardJson },
      });
      const cardId = createResp?.data?.card_id;
      if (!cardId) {
        console.warn('[feishu] Card create returned no card_id');
        return false;
      }

      const cardContent = JSON.stringify({ type: 'card', data: { card_id: cardId } });
      let msgResp;
      if (replyToMessageId) {
        msgResp = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        msgResp = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: {
            receive_id: chatId,
            msg_type: 'interactive',
            content: cardContent,
          },
        });
      }

      const messageId = msgResp?.data?.message_id;
      if (!messageId) {
        console.warn('[feishu] Card message send returned no message_id');
        return false;
      }

      this.activeCards.set(chatId, {
        cardId,
        messageId,
        sequence: 0,
        startTime: Date.now(),
        toolCalls: [],
        thinking: true,
        pendingText: null,
        lastUpdateAt: 0,
        throttleTimer: null,
      });

      console.log(`[feishu] Streaming card created: cardId=${cardId}, msgId=${messageId}`);
      return true;
    } catch (err) {
      console.warn('[feishu] Failed to create streaming card:', err instanceof Error ? err.message : err);
      return false;
    }
  }

  private updateCardContent(chatId: string, text: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    if (state.thinking && text.trim()) {
      state.thinking = false;
    }
    state.pendingText = text;

    const elapsed = Date.now() - state.lastUpdateAt;
    if (elapsed < CARD_THROTTLE_MS && state.lastUpdateAt > 0) {
      if (!state.throttleTimer) {
        state.throttleTimer = setTimeout(() => {
          state.throttleTimer = null;
          this.flushCardUpdate(chatId);
        }, CARD_THROTTLE_MS - elapsed);
      }
      return;
    }

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }
    this.flushCardUpdate(chatId);
  }

  private flushCardUpdate(chatId: string): void {
    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return;

    // Cap to a Feishu-safe size. Show the TAIL (most recent text) so the live
    // card keeps advancing instead of freezing on an over-limit head.
    const raw = state.pendingText || '';
    const truncated = Buffer.byteLength(raw, 'utf8') > CARD_TEXT_BYTE_BUDGET;
    const shown = truncated ? '…（仅显示最新部分）\n' + capUtf8(raw, CARD_TEXT_BYTE_BUDGET, true) : raw;
    let content = buildStreamingContent(shown, state.toolCalls);
    if (state.retryBanner) {
      content = content ? `${state.retryBanner}\n\n${content}` : state.retryBanner;
    }
    state.sequence++;
    const seq = state.sequence;
    const cardId = state.cardId;

    (this.restClient as any).cardkit.v1.cardElement.content({
      path: { card_id: cardId, element_id: 'streaming_content' },
      data: { content, sequence: seq },
    }).then(() => {
      state.lastUpdateAt = Date.now();
    }).catch((err: unknown) => {
      console.warn('[feishu] streamContent failed:', err instanceof Error ? err.message : err);
    });
  }

  private updateToolProgress(chatId: string, tools: ToolCallInfo[]): void {
    const state = this.activeCards.get(chatId);
    if (!state) return;
    state.toolCalls = tools;
    this.updateCardContent(chatId, state.pendingText || '');
  }

  async finalizeCard(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    tokenUsage?: TokenUsage | null,
    options?: { verboseTools?: boolean },
  ): Promise<boolean> {
    const pending = this.cardCreatePromises.get(chatId);
    if (pending) {
      try { await pending; } catch { /* no card */ }
    }

    const state = this.activeCards.get(chatId);
    if (!state || !this.restClient) return false;

    if (state.throttleTimer) {
      clearTimeout(state.throttleTimer);
      state.throttleTimer = null;
    }

    // Disable streaming first, in its own try — so the Stop button disappears
    // even if the content update below fails for any reason.
    try {
      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.settings({
        path: { card_id: state.cardId },
        data: {
          settings: JSON.stringify({ config: { streaming_mode: false } }),
          sequence: state.sequence,
        },
      });
    } catch (err) {
      console.warn('[feishu] Card settings(disable streaming) failed:', err instanceof Error ? err.message : err);
    }

    try {
      const statusLabels: Record<string, string> = {
        completed: '✅ Completed',
        interrupted: '⚠️ Interrupted',
        error: '❌ Error',
      };
      const elapsedMs = Date.now() - state.startTime;
      const footer: { status: string; elapsed: string; tokens?: string; cost?: string; context?: string } = {
        status: statusLabels[status] || status,
        elapsed: formatElapsed(elapsedMs),
      };

      if (tokenUsage) {
        const inTok = tokenUsage.input_tokens ?? 0;
        const outTok = tokenUsage.output_tokens ?? 0;
        const cacheTok = (tokenUsage.cache_read_input_tokens ?? 0) + (tokenUsage.cache_creation_input_tokens ?? 0);
        footer.tokens = cacheTok > 0
          ? `↓${formatTokenCount(inTok)} ↑${formatTokenCount(outTok)} (cache ${formatTokenCount(cacheTok)})`
          : `↓${formatTokenCount(inTok)} ↑${formatTokenCount(outTok)}`;
        if (tokenUsage.cost_usd != null) {
          footer.cost = `$${tokenUsage.cost_usd.toFixed(4)}`;
        }
        const totalTokens = inTok + outTok;
        const CONTEXT_WINDOW_TOKENS = 200_000; // Claude Sonnet 4 context window
        const contextPct = (totalTokens / CONTEXT_WINDOW_TOKENS * 100).toFixed(1);
        footer.context = `${contextPct}%`;
      }

      // Prepend retry banner so the user sees that a retry happened, even on the final card.
      const finalTextRaw = state.retryBanner
        ? `${state.retryBanner}\n\n${responseText}`
        : responseText;
      // Hard cap so the final card.update never exceeds the Feishu size limit
      // (over-limit → 99992402 → card stuck in streaming). Full content is
      // delivered separately by the bridge when it's too long for the card.
      const finalText = capUtf8(finalTextRaw, CARD_TEXT_BYTE_BUDGET, false);
      const finalCardJson = buildFinalCardJson(finalText, state.toolCalls, footer, { verboseTools: options?.verboseTools });
      state.sequence++;
      await (this.restClient as any).cardkit.v1.card.update({
        path: { card_id: state.cardId },
        data: {
          card: { type: 'card_json', data: finalCardJson },
          sequence: state.sequence,
        },
      });

      console.log(`[feishu] Card finalized: cardId=${state.cardId}, status=${status}, elapsed=${formatElapsed(elapsedMs)}`);
      return true;
    } catch (err: any) {
      const fv = err?.response?.data?.field_violations;
      if (fv) {
        console.warn('[feishu] Card finalize field violations:', JSON.stringify(fv));
      }
      console.warn('[feishu] Card finalize failed:', err instanceof Error ? err.message : err);
      return false;
    } finally {
      this.activeCards.delete(chatId);
    }
  }

  private cleanupCard(chatId: string): void {
    this.cardCreatePromises.delete(chatId);
    const state = this.activeCards.get(chatId);
    if (!state) return;
    if (state.throttleTimer) clearTimeout(state.throttleTimer);
    this.activeCards.delete(chatId);
  }

  hasActiveCard(chatId: string): boolean {
    return this.activeCards.has(chatId);
  }

  /** Return the underlying WebSocket readyState (1 = OPEN), or null if no instance. */
  getWsReadyState(): number | null {
    const ws = (this.wsClient as any)?.wsConfig?.getWSInstance?.();
    return ws?.readyState ?? null;
  }

  /** SDK lifecycle state, including terminal reconnect exhaustion. */
  getWsConnectionHealth(): WsConnectionHealth {
    const status = (this.wsClient as any)?.getConnectionStatus?.();
    if (status?.state) return status as WsConnectionHealth;
    const readyState = this.getWsReadyState();
    return { state: readyState === 1 ? 'connected' : readyState === null ? 'unknown' : 'idle' };
  }

  getLastInboundEventAt(): number | null {
    return this.lastInboundEventAt;
  }

  // ── Streaming adapter interface ────────────────────────────

  onStreamText(chatId: string, fullText: string, sessionId?: string): void {
    if (!this.activeCards.has(chatId)) {
      if (!sessionId) {
        // Without sessionId we can't render a stop button; skip lazy create.
        // onMessageStart should normally have created the card upfront.
        return;
      }
      const messageId = this.lastIncomingMessageId.get(chatId);
      this.createStreamingCard(chatId, sessionId, messageId).then((ok) => {
        if (ok) this.updateCardContent(chatId, fullText);
      }).catch(() => {});
      return;
    }
    this.updateCardContent(chatId, fullText);
  }

  onRetryNotice(chatId: string, info: { reason: string; attempt: number; total: number; originalError: string }): void {
    const state = this.activeCards.get(chatId);
    const reasonLabel = retryReasonLabel(info.reason);
    const banner = `⚠️ **${reasonLabel}** — 自动重试中 (${info.attempt}/${info.total - 1})`;
    if (!state) {
      console.log(`[feishu] onRetryNotice (no active card): ${banner}`);
      return;
    }
    state.retryBanner = banner;
    state.pendingText = null;
    state.toolCalls = [];
    // Force an immediate refresh so user sees the banner right away.
    this.flushCardUpdate(chatId);
  }

  onToolEvent(chatId: string, tools: ToolCallInfo[]): void {
    this.updateToolProgress(chatId, tools);
  }

  async onStreamEnd(
    chatId: string,
    status: 'completed' | 'interrupted' | 'error',
    responseText: string,
    tokenUsage?: TokenUsage | null,
    options?: { verboseTools?: boolean },
  ): Promise<boolean> {
    // If no streaming card was ever created (cron task that produced no text)
    // and the task completed without error, suppress the empty card entirely.
    // Errors and interrupts always fall through so users still see them.
    if (
      status === 'completed'
      && !this.activeCards.has(chatId)
      && !responseText.trim()
    ) {
      return false;
    }
    return this.finalizeCard(chatId, status, responseText, tokenUsage, options);
  }

  // ── Send (3-layer degradation) ─────────────────────────────

  async send(
    chatId: string,
    text: string,
    parseMode?: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    if (parseMode === 'HTML') {
      text = htmlToFeishuMarkdown(text);
    }
    if (parseMode === 'Markdown') {
      text = preprocessFeishuMarkdown(text);
    }

    if (hasComplexMarkdown(text)) {
      return this.sendAsCard(chatId, text, replyToMessageId);
    }
    return this.sendAsPost(chatId, text, replyToMessageId);
  }

  private async sendAsCard(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const cardContent = buildCardContent(text);

    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardContent, msg_type: 'interactive' },
        });
      } else {
        res = await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardContent },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu] Card send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu] Card send error, falling back to post:', err instanceof Error ? err.message : err);
    }

    return this.sendAsPost(chatId, text, replyToMessageId);
  }

  private async sendAsPost(chatId: string, text: string, replyToMessageId?: string): Promise<SendResult> {
    const postContent = buildPostContent(text);

    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: postContent, msg_type: 'post' },
        });
      } else {
        res = await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'post', content: postContent },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu] Post send failed:', res?.msg, res?.code);
    } catch (err) {
      console.warn('[feishu] Post send error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Final fallback: plain text
    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient!.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: JSON.stringify({ text }), msg_type: 'text' },
        });
      } else {
        res = await this.restClient!.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Permission Card ────────────────────────────────────────

  async sendCronConfirmCard(chatId: string, opts: {
    pendingId: string;
    cron: string;
    prompt: string;
    targetChatId: string;
    nextFireAt: number;
    sameAsOrigin: boolean;
  }): Promise<SendResult> {
    if (!this.restClient) return { ok: false, error: 'Feishu client not initialized' };
    const cardJson = buildCronConfirmCard(opts);
    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'interactive', content: cardJson },
      });
      if (res?.data?.message_id) return { ok: true, messageId: res.data.message_id };
      return { ok: false, error: res?.msg || 'unknown error' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }


  async sendPermissionCard(
    chatId: string,
    mdText: string,
    permissionRequestId: string,
    replyToMessageId?: string,
  ): Promise<SendResult> {
    if (!this.restClient) {
      return { ok: false, error: 'Feishu client not initialized' };
    }

    const cardJson = buildPermissionButtonCard(mdText, permissionRequestId, chatId);

    try {
      let res;
      if (replyToMessageId) {
        res = await this.restClient.im.message.reply({
          path: { message_id: replyToMessageId },
          data: { content: cardJson, msg_type: 'interactive' },
        });
      } else {
        res = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: chatId, msg_type: 'interactive', content: cardJson },
        });
      }
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      console.warn('[feishu] Permission card send failed:', res?.msg);
    } catch (err) {
      console.warn('[feishu] Permission card error, falling back to text:', err instanceof Error ? err.message : err);
    }

    // Fallback: plain text with reply instructions
    const plainText = [
      mdText,
      '',
      '---',
      'Reply: 1 = Allow once | 2 = Allow session | 3 = Deny',
    ].join('\n');

    try {
      const res = await this.restClient.im.message.create({
        params: { receive_id_type: 'chat_id' },
        data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text: plainText }) },
      });
      if (res?.data?.message_id) {
        return { ok: true, messageId: res.data.message_id };
      }
      return { ok: false, error: res?.msg || 'Send failed' };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : 'Send failed' };
    }
  }

  // ── Authorization ──────────────────────────────────────────

  isAuthorized(userId: string, chatId: string): boolean {
    const allowed = this.config.feishuAllowedUsers;
    if (!allowed || allowed.length === 0) return true;
    return allowed.includes(userId) || allowed.includes(chatId);
  }

  // ── Incoming event handler ─────────────────────────────────

  private async handleIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    try {
      await this.processIncomingEvent(data);
    } catch (err) {
      console.error(
        '[feishu] Unhandled error in event handler:',
        err instanceof Error ? err.stack || err.message : err,
      );
    }
  }

  private async processIncomingEvent(data: FeishuMessageEventData): Promise<void> {
    const msg = data.message;
    const sender = data.sender;

    // Filter out bot messages
    if (sender.sender_type === 'bot') return;

    // Dedup
    if (this.seenMessageIds.has(msg.message_id)) return;
    this.addToDedup(msg.message_id);

    const chatId = msg.chat_id;
    const userId = sender.sender_id?.open_id
      || sender.sender_id?.user_id
      || sender.sender_id?.union_id
      || '';
    const isGroup = msg.chat_type === 'group';

    // Authorization
    if (!this.isAuthorized(userId, chatId)) {
      console.warn('[feishu] Unauthorized:', userId, chatId);
      return;
    }

    // Group chat: require @mention by default
    if (isGroup) {
      if (this.config.feishuRequireMention && !this.isBotMentioned(msg.mentions)) {
        console.log('[feishu] Group message ignored (bot not @mentioned), chatId:', chatId);
        return;
      }
    }

    // Track last message ID for typing indicator
    this.lastIncomingMessageId.set(chatId, msg.message_id);

    // Extract content based on message type
    let text = '';
    const attachments: FileAttachment[] = [];
    const messageType = msg.message_type;

    if (messageType === 'text') {
      text = this.parseTextContent(msg.content);
    } else if (messageType === 'image') {
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const attachment = await this.downloadResource(msg.message_id, fileKey, 'image');
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = '[image download failed]';
        }
      }
    } else if (messageType === 'file' || messageType === 'audio' || messageType === 'video' || messageType === 'media') {
      const fileKey = this.extractFileKey(msg.content);
      if (fileKey) {
        const resourceType = messageType === 'audio' || messageType === 'video' || messageType === 'media'
          ? messageType
          : 'file';
        const attachment = await this.downloadResource(msg.message_id, fileKey, resourceType);
        if (attachment) {
          attachments.push(attachment);
        } else {
          text = `[${messageType} download failed]`;
        }
      }
    } else if (messageType === 'post') {
      const { extractedText, imageKeys } = this.parsePostContent(msg.content);
      text = extractedText;
      for (const key of imageKeys) {
        const attachment = await this.downloadResource(msg.message_id, key, 'image');
        if (attachment) attachments.push(attachment);
      }
    } else {
      console.log(`[feishu] Unsupported message type: ${messageType}, msgId: ${msg.message_id}`);
      return;
    }

    // Strip @mention markers
    text = this.stripMentionMarkers(text);

    if (!text.trim() && attachments.length === 0) return;

    const timestamp = parseInt(msg.create_time, 10) || Date.now();

    // Pull quoted-message context if this is a Feishu reply/quote
    let quotedContent: string | undefined;
    let quotedSenderName: string | undefined;
    if (msg.parent_id) {
      const quoted = await this.fetchQuotedMessage(msg.parent_id);
      if (quoted) {
        quotedContent = quoted.text;
        quotedSenderName = quoted.senderName;
      }
    }

    // Check for /perm text command
    const trimmedText = text.trim();
    if (trimmedText.startsWith('/perm ')) {
      const permParts = trimmedText.split(/\s+/);
      if (permParts.length >= 3) {
        const action = permParts[1];
        const permId = permParts.slice(2).join(' ');
        this.enqueue({
          messageId: msg.message_id,
          chatId,
          userId,
          text: trimmedText,
          timestamp,
          callbackData: `perm:${action}:${permId}`,
        });
        return;
      }
    }

    this.enqueue({
      messageId: msg.message_id,
      chatId,
      userId,
      text: text.trim(),
      timestamp,
      attachments: attachments.length > 0 ? attachments : undefined,
      quotedContent,
      quotedSenderName,
    });
  }

  /**
   * Fetch a previously-sent message by ID and extract a plain-text rendering
   * of its content. Used to pull "the message the user is replying to" into
   * the prompt, since Feishu events do NOT inline the quoted text.
   *
   * Returns null if the fetch fails or the message has no extractable text.
   */
  private async fetchQuotedMessage(
    messageId: string,
  ): Promise<{ text: string; senderName?: string } | null> {
    if (!this.restClient) return null;
    try {
      const res: any = await this.restClient.im.message.get({
        path: { message_id: messageId },
      });
      const items: any[] = res?.data?.items || [];
      if (items.length === 0) return null;
      const item = items[0];
      const msgType: string = item.msg_type || '';
      const bodyContent: string = item?.body?.content || '';

      let extracted = '';
      if (msgType === 'text') {
        extracted = this.parseTextContent(bodyContent);
      } else if (msgType === 'post') {
        extracted = this.parsePostContent(bodyContent).extractedText;
      } else if (msgType === 'image') {
        extracted = '[图片]';
      } else if (msgType === 'file') {
        extracted = '[文件]';
      } else if (msgType === 'audio') {
        extracted = '[语音]';
      } else if (msgType === 'video' || msgType === 'media') {
        extracted = '[视频]';
      } else if (msgType === 'interactive') {
        // Card — try to pull any obvious text fields
        try {
          const parsed = JSON.parse(bodyContent);
          extracted = this.flattenCardText(parsed) || '[卡片]';
        } catch {
          extracted = '[卡片]';
        }
      } else {
        extracted = `[${msgType}]`;
      }

      extracted = this.stripMentionMarkers(extracted).trim();
      if (!extracted) return null;

      // Sender attribution — best-effort, may be absent
      const senderId: string | undefined = item?.sender?.id;
      return { text: extracted, senderName: senderId };
    } catch (err) {
      console.warn(
        '[feishu] Failed to fetch quoted message',
        messageId,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /** Walk a card JSON tree and concatenate any plain-text fields. */
  private flattenCardText(node: any): string {
    if (!node) return '';
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map((n) => this.flattenCardText(n)).join(' ');
    if (typeof node === 'object') {
      const parts: string[] = [];
      if (typeof node.text === 'string') parts.push(node.text);
      if (typeof node.content === 'string') parts.push(node.content);
      if (typeof node.title === 'string') parts.push(node.title);
      for (const key of Object.keys(node)) {
        if (key === 'text' || key === 'content' || key === 'title') continue;
        parts.push(this.flattenCardText(node[key]));
      }
      return parts.filter(Boolean).join(' ').trim();
    }
    return '';
  }

  // ── Content parsing ────────────────────────────────────────

  private parseTextContent(content: string): string {
    try {
      const parsed = JSON.parse(content);
      return parsed.text || '';
    } catch {
      return content;
    }
  }

  private extractFileKey(content: string): string | null {
    try {
      const parsed = JSON.parse(content);
      return parsed.image_key || parsed.file_key || parsed.imageKey || parsed.fileKey || null;
    } catch {
      return null;
    }
  }

  private parsePostContent(content: string): { extractedText: string; imageKeys: string[] } {
    const imageKeys: string[] = [];
    const textParts: string[] = [];

    try {
      const parsed = JSON.parse(content);
      if (parsed.title) textParts.push(parsed.title);

      const paragraphs = parsed.content;
      if (Array.isArray(paragraphs)) {
        for (const paragraph of paragraphs) {
          if (!Array.isArray(paragraph)) continue;
          for (const element of paragraph) {
            if (element.tag === 'text' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'a' && element.text) {
              textParts.push(element.text);
            } else if (element.tag === 'img') {
              const key = element.image_key || element.file_key || element.imageKey;
              if (key) imageKeys.push(key);
            }
          }
          textParts.push('\n');
        }
      }
    } catch { /* parse error */ }

    return { extractedText: textParts.join('').trim(), imageKeys };
  }

  // ── Bot identity ───────────────────────────────────────────

  private async resolveBotIdentity(
    appId: string,
    appSecret: string,
    domain: lark.Domain,
  ): Promise<void> {
    try {
      const baseUrl = domain === lark.Domain.Lark
        ? 'https://open.larksuite.com'
        : 'https://open.feishu.cn';

      const tokenRes = await fetch(`${baseUrl}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
        signal: AbortSignal.timeout(10_000),
      });
      const tokenData: any = await tokenRes.json();
      if (!tokenData.tenant_access_token) {
        console.warn('[feishu] Failed to get tenant access token');
        return;
      }

      const botRes = await fetch(`${baseUrl}/open-apis/bot/v3/info/`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${tokenData.tenant_access_token}` },
        signal: AbortSignal.timeout(10_000),
      });
      const botData: any = await botRes.json();
      if (botData?.bot?.open_id) {
        this.botOpenId = botData.bot.open_id;
        this.botIds.add(botData.bot.open_id);
      }
      if (botData?.bot?.bot_id) {
        this.botIds.add(botData.bot.bot_id);
      }
      if (!this.botOpenId) {
        console.warn('[feishu] Could not resolve bot open_id');
      }
    } catch (err) {
      console.warn('[feishu] Failed to resolve bot identity:', err instanceof Error ? err.message : err);
    }
  }

  // ── @Mention detection ─────────────────────────────────────

  private isBotMentioned(
    mentions?: FeishuMessageEventData['message']['mentions'],
  ): boolean {
    if (!mentions || this.botIds.size === 0) return false;
    return mentions.some((m) => {
      const ids = [m.id.open_id, m.id.user_id, m.id.union_id].filter(Boolean) as string[];
      return ids.some((id) => this.botIds.has(id));
    });
  }

  private stripMentionMarkers(text: string): string {
    return text.replace(/@_user_\d+/g, '').trim();
  }

  // ── Group / chat management ────────────────────────────────

  /**
   * Resolve a chat_id to a human-readable name. Cached in-memory for 5 min.
   * Returns null on lookup failure (network, scope, deleted chat).
   *
   * For p2p chats, Feishu's chat.get returns the other party's name as the
   * chat name; for groups, the group title.
   */
  private chatNameCache = new Map<string, { name: string | null; expiresAt: number }>();
  async getChatName(chatId: string): Promise<string | null> {
    const cached = this.chatNameCache.get(chatId);
    if (cached && cached.expiresAt > Date.now()) return cached.name;
    if (!this.restClient) return null;
    try {
      const res: any = await (this.restClient as any).im.chat.get({
        path: { chat_id: chatId },
      });
      const data = res?.data ?? res;
      let name: string | null = data?.name || null;
      // p2p sometimes returns empty name; fall back to chat_mode hint.
      if (!name && data?.chat_mode === 'p2p') name = '(direct message)';
      if (!name && data?.description) name = data.description;
      this.chatNameCache.set(chatId, { name, expiresAt: Date.now() + 5 * 60 * 1000 });
      return name;
    } catch (err) {
      // Cache the failure for 1 min so we don't spam on every dashboard refresh.
      this.chatNameCache.set(chatId, { name: null, expiresAt: Date.now() + 60 * 1000 });
      return null;
    }
  }

  /**
   * Create a new group chat, invite the given users, then send a greeting
   * message that @-mentions all invitees.
   *
   * Requires Feishu scopes: im:chat, im:chat.members:write (or im:chat.members),
   * plus im:message which is already granted for normal messaging.
   */
  async createGroupAndInvite(params: {
    chatName: string;
    inviteOpenIds: string[];
    greeting?: string;
  }): Promise<{ ok: boolean; chatId?: string; invited?: string[]; warning?: string; error?: string }> {
    if (!this.restClient) return { ok: false, error: 'REST client not initialized' };
    try {
      // 1. Create the chat. Bot is automatically added as owner.
      const createRes = await (this.restClient as any).im.chat.create({
        data: {
          name: params.chatName,
          description: `Created by ${this.botOpenId || 'bridge bot'} on ${new Date().toISOString()}`,
          chat_mode: 'group',
          chat_type: 'private',
        },
      });
      const chatId = createRes?.data?.chat_id || createRes?.chat_id;
      if (!chatId) {
        return { ok: false, error: `chat.create returned no chat_id (raw=${JSON.stringify(createRes).slice(0, 300)})` };
      }

      // 2. Invite members by open_id.
      let invited: string[] = [];
      let inviteWarning: string | undefined;
      if (params.inviteOpenIds.length > 0) {
        try {
          const inviteRes = await (this.restClient as any).im.chatMembers.create({
            path: { chat_id: chatId },
            params: { member_id_type: 'open_id' },
            data: { id_list: params.inviteOpenIds },
          });
          invited = inviteRes?.data?.invalid_id_list?.length
            ? params.inviteOpenIds.filter((id) => !inviteRes.data.invalid_id_list.includes(id))
            : params.inviteOpenIds;
          const invalid = inviteRes?.data?.invalid_id_list || [];
          if (invalid.length > 0) {
            inviteWarning = `invalid IDs: ${invalid.join(', ')}`;
            console.warn(`[feishu] createGroupAndInvite: ${inviteWarning}`);
          }
        } catch (e) {
          // Bubble up the full error so callers can surface it to the user.
          const errMsg = e instanceof Error ? e.message : String(e);
          inviteWarning = `invite API failed: ${errMsg}`;
          console.warn('[feishu] createGroupAndInvite:', inviteWarning);
        }
      }

      // 3. Send greeting that @-mentions every successfully invited user.
      if (params.greeting !== undefined) {
        const mentionTags = invited.map((id) => `<at user_id="${id}"></at>`).join(' ');
        const text = mentionTags ? `${mentionTags} ${params.greeting}` : params.greeting;
        try {
          await this.restClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: { receive_id: chatId, msg_type: 'text', content: JSON.stringify({ text }) },
          });
        } catch (e) {
          console.warn('[feishu] createGroupAndInvite: greeting send failed:', e instanceof Error ? e.message : e);
        }
      }

      return { ok: true, chatId, invited, warning: inviteWarning };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[feishu] createGroupAndInvite failed:', msg);
      return { ok: false, error: msg };
    }
  }

  // ── Resource upload (bot → user) ───────────────────────────

  /**
   * Upload a local file and send it to a chat as image or file message.
   * Routes by extension: common image extensions → im.image.create + msg_type:image,
   * everything else → im.file.create + msg_type:file.
   *
   * @returns { ok, messageId, fileKey, kind } on success; { ok:false, error } otherwise.
   */
  async uploadAndSendFile(params: {
    chatId: string;
    filePath: string;
    replyToMessageId?: string;
    caption?: string;
  }): Promise<{ ok: boolean; messageId?: string; fileKey?: string; kind?: 'image' | 'file'; error?: string }> {
    if (!this.restClient) return { ok: false, error: 'REST client not initialized' };
    const fs = await import('node:fs');
    const path = await import('node:path');

    let stat: import('node:fs').Stats;
    try {
      stat = fs.statSync(params.filePath);
    } catch (e) {
      return { ok: false, error: `File not accessible: ${(e as Error).message}` };
    }
    if (!stat.isFile()) return { ok: false, error: 'Path is not a regular file' };

    const ext = path.extname(params.filePath).toLowerCase();
    const isImage = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp'].includes(ext);
    const fileName = path.basename(params.filePath);

    try {
      let fileKey: string;
      if (isImage) {
        const res = await (this.restClient as any).im.image.create({
          data: {
            image_type: 'message',
            image: fs.createReadStream(params.filePath),
          },
        });
        fileKey = res?.data?.image_key || res?.image_key;
        if (!fileKey) return { ok: false, error: `Upload returned no image_key (raw=${JSON.stringify(res).slice(0, 300)})` };
      } else {
        // file_type: 'stream' is the catch-all per Feishu docs.
        const fileType = ext === '.pdf' ? 'pdf'
          : ['.doc', '.docx'].includes(ext) ? 'doc'
          : ['.xls', '.xlsx'].includes(ext) ? 'xls'
          : ['.ppt', '.pptx'].includes(ext) ? 'ppt'
          : ext === '.mp4' ? 'mp4'
          : ext === '.opus' ? 'opus'
          : 'stream';
        const res = await (this.restClient as any).im.file.create({
          data: {
            file_type: fileType,
            file_name: fileName,
            file: fs.createReadStream(params.filePath),
          },
        });
        fileKey = res?.data?.file_key || res?.file_key;
        if (!fileKey) return { ok: false, error: `Upload returned no file_key (raw=${JSON.stringify(res).slice(0, 300)})` };
      }

      const content = isImage
        ? JSON.stringify({ image_key: fileKey })
        : JSON.stringify({ file_key: fileKey });
      const msgType = isImage ? 'image' : 'file';

      let messageId: string | undefined;
      if (params.replyToMessageId) {
        const reply = await this.restClient.im.message.reply({
          path: { message_id: params.replyToMessageId },
          data: { content, msg_type: msgType },
        });
        messageId = (reply as any)?.data?.message_id;
      } else {
        const created = await this.restClient.im.message.create({
          params: { receive_id_type: 'chat_id' },
          data: { receive_id: params.chatId, content, msg_type: msgType },
        });
        messageId = (created as any)?.data?.message_id;
      }

      // Optional caption as a separate text message in the same chat.
      if (params.caption && params.caption.trim()) {
        try {
          await this.restClient.im.message.create({
            params: { receive_id_type: 'chat_id' },
            data: {
              receive_id: params.chatId,
              content: JSON.stringify({ text: params.caption }),
              msg_type: 'text',
            },
          });
        } catch (e) {
          console.warn('[feishu] uploadAndSendFile: caption send failed:', e instanceof Error ? e.message : e);
        }
      }

      return { ok: true, messageId, fileKey, kind: isImage ? 'image' : 'file' };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[feishu] uploadAndSendFile failed:', msg);
      return { ok: false, error: msg };
    }
  }

  // ── Resource download ──────────────────────────────────────

  private async downloadResource(
    messageId: string,
    fileKey: string,
    resourceType: string,
  ): Promise<FileAttachment | null> {
    if (!this.restClient) return null;

    try {
      const res = await this.restClient.im.messageResource.get({
        path: { message_id: messageId, file_key: fileKey },
        params: { type: resourceType === 'image' ? 'image' : 'file' },
      });

      if (!res) return null;

      let buffer: Buffer;
      try {
        const readable = res.getReadableStream();
        const chunks: Buffer[] = [];
        let totalSize = 0;
        for await (const chunk of readable) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalSize += buf.length;
          if (totalSize > MAX_FILE_SIZE) {
            console.warn(`[feishu] Resource too large (>${MAX_FILE_SIZE}), key: ${fileKey}`);
            return null;
          }
          chunks.push(buf);
        }
        buffer = Buffer.concat(chunks);
      } catch {
        // Stream failed — fallback to writeFile + read
        const fs = await import('node:fs');
        const os = await import('node:os');
        const path = await import('node:path');
        const tmpPath = path.join(os.tmpdir(), `feishu-dl-${crypto.randomUUID()}`);
        try {
          await res.writeFile(tmpPath);
          buffer = fs.readFileSync(tmpPath);
          if (buffer.length > MAX_FILE_SIZE) return null;
        } finally {
          try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
        }
      }

      if (!buffer || buffer.length === 0) return null;

      const base64 = buffer.toString('base64');
      const mimeType = MIME_BY_TYPE[resourceType] || 'application/octet-stream';
      const ext = resourceType === 'image' ? 'png'
        : resourceType === 'audio' ? 'ogg'
        : resourceType === 'video' ? 'mp4'
        : 'bin';

      return {
        id: crypto.randomUUID(),
        name: `${fileKey}.${ext}`,
        type: mimeType,
        size: buffer.length,
        data: base64,
      };
    } catch (err) {
      console.error(
        `[feishu] Resource download failed (type=${resourceType}, key=${fileKey}):`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  // ── Utilities ──────────────────────────────────────────────

  private addToDedup(messageId: string): void {
    this.seenMessageIds.set(messageId, true);
    if (this.seenMessageIds.size > DEDUP_MAX) {
      const excess = this.seenMessageIds.size - DEDUP_MAX;
      let removed = 0;
      for (const key of this.seenMessageIds.keys()) {
        if (removed >= excess) break;
        this.seenMessageIds.delete(key);
        removed++;
      }
    }
  }
}
