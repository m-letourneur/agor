/**
 * WhatsApp Connector (Baileys / WhatsApp Web)
 *
 * Connects to a personal WhatsApp account via the multi-device Web protocol.
 * Users link their account by scanning a QR code (like WhatsApp Desktop).
 *
 * Uses @whiskeysockets/baileys — no Meta Business account or API fees required.
 *
 * Config shape (stored in gateway_channels.config):
 *   {
 *     dm_policy?: 'open' | 'allowlist' | 'disabled',       // Default: 'open'
 *     group_policy?: 'open' | 'allowlist' | 'disabled',    // Default: 'disabled'
 *     allowlist?: string[],         // E.164 phone numbers (e.g. ['15551234567'])
 *     read_receipts?: boolean,      // Send read receipts (default: true)
 *     max_message_length?: number,  // Chunk outbound messages (default: 4000)
 *   }
 *
 * Credentials: Stored on disk at ~/.agor/credentials/whatsapp/<channelId>/
 *   Managed by Baileys' useMultiFileAuthState(). Contains device identity,
 *   Signal protocol keys, etc. Generated after QR code pairing.
 *
 * Thread ID format: "wa:<phone_number>" for DMs, "wa:g:<group_jid>" for groups
 *   e.g. "wa:15551234567", "wa:g:120363XXXX@g.us"
 */

import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import makeWASocket, {
  type ConnectionUpdate,
  DisconnectReason,
  type MessagesUpsert,
  useMultiFileAuthState,
  type WAMessage,
  type WASocket,
} from '@whiskeysockets/baileys';

import type { ChannelType } from '../../types/gateway';
import type { GatewayConnector, InboundMessage } from '../connector';

interface WhatsAppConfig {
  dm_policy?: 'open' | 'allowlist' | 'disabled';
  group_policy?: 'open' | 'allowlist' | 'disabled';
  allowlist?: string[];
  read_receipts?: boolean;
  max_message_length?: number;
}

/** Thread ID prefix for DMs */
const DM_PREFIX = 'wa:';
/** Thread ID prefix for groups */
const GROUP_PREFIX = 'wa:g:';

/**
 * Extract phone number or JID from thread ID
 */
function parseThreadId(threadId: string): { jid: string; isGroup: boolean } {
  if (threadId.startsWith(GROUP_PREFIX)) {
    return { jid: threadId.slice(GROUP_PREFIX.length), isGroup: true };
  }
  if (threadId.startsWith(DM_PREFIX)) {
    const phone = threadId.slice(DM_PREFIX.length);
    return { jid: `${phone}@s.whatsapp.net`, isGroup: false };
  }
  throw new Error(`Invalid WhatsApp thread ID format: "${threadId}"`);
}

/**
 * Build thread ID from JID
 */
function buildThreadId(jid: string): string {
  if (jid.endsWith('@g.us')) {
    return `${GROUP_PREFIX}${jid}`;
  }
  // Strip @s.whatsapp.net suffix to get phone number
  const phone = jid.replace(/@s\.whatsapp\.net$/, '');
  return `${DM_PREFIX}${phone}`;
}

/**
 * Extract phone number from JID (strip @s.whatsapp.net)
 */
function jidToPhone(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, '').replace(/@lid$/, '');
}

/**
 * Convert Markdown to WhatsApp formatting
 *
 * WhatsApp supports: *bold*, _italic_, ~strikethrough~, ```code```, `mono`
 */
function markdownToWhatsApp(markdown: string): string {
  return (
    markdown
      // Bold: **text** → *text*
      .replace(/\*\*(.+?)\*\*/g, '*$1*')
      // Strikethrough: ~~text~~ → ~text~
      .replace(/~~(.+?)~~/g, '~$1~')
      // Links: [text](url) → text (url)
      .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
  );
}

/**
 * Get credentials directory for a WhatsApp channel
 */
function getCredsDir(channelId: string): string {
  return join(homedir(), '.agor', 'credentials', 'whatsapp', channelId);
}

export class WhatsAppConnector implements GatewayConnector {
  readonly channelType: ChannelType = 'whatsapp';

  private config: WhatsAppConfig;
  private channelId: string;
  private socket: WASocket | null = null;
  private inboundCallback: ((msg: InboundMessage) => void) | null = null;
  private saveCreds: (() => Promise<void>) | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Event emitter for surfacing connection events (QR codes, status changes)
   * to the gateway service, which forwards them to the UI via WebSocket.
   */
  private connectionEventCallback: ((event: WhatsAppConnectionEvent) => void) | null = null;

  constructor(config: Record<string, unknown>) {
    this.config = config as unknown as WhatsAppConfig;
    this.channelId = (config._channelId as string) ?? 'unknown';
  }

  /**
   * Register a callback for connection events (QR code, connected, disconnected).
   * Called by the gateway service to bridge events to WebSocket.
   */
  onConnectionEvent(callback: (event: WhatsAppConnectionEvent) => void): void {
    this.connectionEventCallback = callback;
  }

  /**
   * Send a message to a WhatsApp chat
   */
  async sendMessage(req: {
    threadId: string;
    text: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    if (!this.socket) {
      throw new Error('WhatsApp connector is not connected');
    }

    const { jid } = parseThreadId(req.threadId);
    const text = this.formatMessage(req.text);

    // Chunk long messages
    const maxLen = this.config.max_message_length ?? 4000;
    const chunks = chunkText(text, maxLen);

    let lastMessageId = '';
    for (const chunk of chunks) {
      const result = await this.socket.sendMessage(jid, { text: chunk });
      lastMessageId = result?.key?.id ?? '';
    }

    return lastMessageId;
  }

  /**
   * Start listening for inbound messages via Baileys WebSocket.
   *
   * On first connection, emits QR code events that the UI renders for scanning.
   * On subsequent connections (daemon restart), reconnects silently using stored creds.
   */
  async startListening(callback: (msg: InboundMessage) => void): Promise<void> {
    this.inboundCallback = callback;

    const credsDir = getCredsDir(this.channelId);
    mkdirSync(credsDir, { recursive: true });

    // biome-ignore lint/correctness/useHookAtTopLevel: useMultiFileAuthState is from Baileys library, not a React hook
    const { state, saveCreds } = await useMultiFileAuthState(credsDir);
    this.saveCreds = saveCreds;

    await this.connectSocket(state);
  }

  /**
   * Stop listening and close the WebSocket
   */
  async stopListening(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.socket) {
      this.socket.ev.removeAllListeners('connection.update');
      this.socket.ev.removeAllListeners('creds.update');
      this.socket.ev.removeAllListeners('messages.upsert');
      this.socket.end(undefined);
      this.socket = null;
    }

    this.inboundCallback = null;
    this.saveCreds = null;
  }

  /**
   * Convert Markdown to WhatsApp formatting
   */
  formatMessage(markdown: string): string {
    return markdownToWhatsApp(markdown);
  }

  // ─── Private ───────────────────────────────────────────────────────

  /**
   * Create a logger compatible with Baileys.
   * The child() method must return a logger with the same interface.
   */
  private createBaileysLogger() {
    const logger = {
      level: 'silent' as const,
      trace: () => {},
      debug: () => {},
      info: () => {},
      warn: (...args: unknown[]) => console.warn('[whatsapp:baileys]', ...args),
      error: (...args: unknown[]) => console.error('[whatsapp:baileys]', ...args),
      fatal: (...args: unknown[]) => console.error('[whatsapp:baileys:fatal]', ...args),
      child: () => logger,
    };
    return logger;
  }

  private async connectSocket(
    authState: Awaited<ReturnType<typeof useMultiFileAuthState>>['state']
  ): Promise<void> {
    this.socket = makeWASocket({
      auth: authState,
      // Use Chrome browser identifier for better compatibility
      browser: ['Chrome (Linux)', 'Chrome', '122.0.0'],
      printQRInTerminal: false, // We handle QR code via WebSocket
      // Suppress Baileys' verbose logging — use custom logger
      // Note: child() must return a logger with same interface to avoid "trace is not a function" errors
      // biome-ignore lint/suspicious/noExplicitAny: Baileys logger type is incompatible, requires type assertion
      logger: this.createBaileysLogger() as any,
      markOnlineOnConnect: false,
      syncFullHistory: false,
      connectTimeoutMs: 60_000,
      defaultQueryTimeoutMs: 60_000,
      getMessage: async () => undefined,
    });

    // Connection state changes (QR code, connected, disconnected)
    this.socket.ev.on('connection.update', (update: ConnectionUpdate) => {
      this.handleConnectionUpdate(update);
    });

    // Persist auth credentials on update
    this.socket.ev.on('creds.update', async () => {
      if (this.saveCreds) {
        await this.saveCreds();
      }
    });

    // Inbound messages
    this.socket.ev.on('messages.upsert', ({ messages, type }: MessagesUpsert) => {
      if (type !== 'notify') return; // Only process real-time messages

      for (const msg of messages) {
        this.handleInboundMessage(msg);
      }
    });
  }

  private handleConnectionUpdate(update: ConnectionUpdate): void {
    const { connection, lastDisconnect, qr } = update;

    // Log all connection updates for debugging
    console.log(`[whatsapp] Connection update:`, {
      connection,
      qr: qr ? 'present' : 'none',
      hasError: !!lastDisconnect?.error,
      channelId: this.channelId.substring(0, 8),
    });

    // QR code for pairing
    if (qr) {
      console.log(`[whatsapp] QR code generated for channel ${this.channelId.substring(0, 8)}`);
      this.connectionEventCallback?.({
        type: 'qr',
        channelId: this.channelId,
        qr,
      });
    }

    if (connection === 'open') {
      const phoneNumber = this.socket?.user?.id ? jidToPhone(this.socket.user.id) : undefined;
      console.log(
        `[whatsapp] Connected${phoneNumber ? ` as ${phoneNumber}` : ''} (channel ${this.channelId.substring(0, 8)})`
      );
      this.connectionEventCallback?.({
        type: 'connected',
        channelId: this.channelId,
        phoneNumber,
      });
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error as
        | (Error & { output?: { statusCode?: number } })
        | undefined;
      const statusCode = error?.output?.statusCode;
      const reason = statusCode ?? 'unknown';

      console.log(
        `[whatsapp] Connection closed: reason=${reason} (channel ${this.channelId.substring(0, 8)})`
      );

      // Log full error details for debugging
      if (error) {
        console.error(`[whatsapp] Close error details:`, {
          message: error.message,
          statusCode,
          stack: error.stack,
        });
      }

      if (statusCode === DisconnectReason.loggedOut) {
        // User logged out — don't reconnect, surface to UI
        console.log('[whatsapp] Logged out — requires re-pairing');
        this.connectionEventCallback?.({
          type: 'disconnected',
          channelId: this.channelId,
          reason: 'logged_out',
        });
        return;
      }

      // All other disconnect reasons: auto-reconnect
      this.connectionEventCallback?.({
        type: 'disconnected',
        channelId: this.channelId,
        reason: 'connection_lost',
      });

      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;

    const delay = 3000 + Math.random() * 2000; // 3-5s jitter
    console.log(
      `[whatsapp] Reconnecting in ${Math.round(delay / 1000)}s (channel ${this.channelId.substring(0, 8)})`
    );

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        const credsDir = getCredsDir(this.channelId);
        // biome-ignore lint/correctness/useHookAtTopLevel: useMultiFileAuthState is from Baileys library, not a React hook
        const { state, saveCreds } = await useMultiFileAuthState(credsDir);
        this.saveCreds = saveCreds;
        await this.connectSocket(state);
      } catch (error) {
        console.error('[whatsapp] Reconnect failed:', error);
        this.scheduleReconnect(); // Retry
      }
    }, delay);
  }

  private handleInboundMessage(msg: WAMessage): void {
    // Skip our own messages
    if (msg.key.fromMe) return;

    const jid = msg.key.remoteJid;
    if (!jid) return;

    // Skip status broadcasts
    if (jid === 'status@broadcast') return;

    const isGroup = jid.endsWith('@g.us');

    // Apply DM/group policy
    const dmPolicy = this.config.dm_policy ?? 'open';
    const groupPolicy = this.config.group_policy ?? 'disabled';

    if (!isGroup && dmPolicy === 'disabled') return;
    if (isGroup && groupPolicy === 'disabled') return;

    // Extract sender phone number
    const senderJid = isGroup ? msg.key.participant : jid;
    if (!senderJid) return;
    const senderPhone = jidToPhone(senderJid);

    // Allowlist check
    if ((!isGroup && dmPolicy === 'allowlist') || (isGroup && groupPolicy === 'allowlist')) {
      const allowlist = this.config.allowlist ?? [];
      if (!allowlist.includes(senderPhone)) {
        return; // Not in allowlist
      }
    }

    // Extract text content
    const text = extractTextFromMessage(msg.message as Record<string, unknown> | null | undefined);
    if (!text) {
      console.log(`[whatsapp] Ignoring non-text message from ${senderPhone}`);
      return;
    }

    const threadId = buildThreadId(jid);
    const ts = msg.messageTimestamp;
    const timestamp =
      typeof ts === 'number'
        ? new Date(ts * 1000).toISOString()
        : ts && typeof (ts as { toNumber?: () => number }).toNumber === 'function'
          ? new Date((ts as { toNumber: () => number }).toNumber() * 1000).toISOString()
          : new Date().toISOString();

    console.log(
      `[whatsapp] Inbound: thread=${threadId} from=${senderPhone} (channel ${this.channelId.substring(0, 8)})`
    );

    // Send read receipt if configured
    if (this.config.read_receipts !== false && this.socket && msg.key.id) {
      this.socket
        .readMessages([msg.key])
        .catch((err: Error) => console.warn('[whatsapp] Failed to send read receipt:', err));
    }

    this.inboundCallback?.({
      threadId,
      text,
      userId: senderPhone,
      timestamp,
      metadata: {
        is_group: isGroup,
        ...(isGroup && msg.key.participant ? { group_participant: msg.key.participant } : {}),
      },
    });
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

/**
 * Extract text content from a WhatsApp message.
 * Returns null for media-only messages (Phase 1: text only).
 */
function extractTextFromMessage(
  message: Record<string, unknown> | null | undefined
): string | null {
  if (!message) return null;

  // Plain text message
  if (typeof message.conversation === 'string') {
    return message.conversation;
  }

  // Extended text (with link previews, mentions, etc.)
  const ext = message.extendedTextMessage as Record<string, unknown> | undefined;
  if (ext && typeof ext.text === 'string') {
    return ext.text;
  }

  // Image/video/document with caption
  for (const key of ['imageMessage', 'videoMessage', 'documentMessage']) {
    const media = message[key] as Record<string, unknown> | undefined;
    if (media && typeof media.caption === 'string') {
      return media.caption;
    }
  }

  return null;
}

/**
 * Split text into chunks at newline boundaries
 */
function chunkText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    // Find last newline before maxLen
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt <= 0) splitAt = maxLen; // No newline found, hard split

    chunks.push(remaining.substring(0, splitAt));
    remaining = remaining.substring(splitAt).replace(/^\n/, '');
  }

  if (remaining) chunks.push(remaining);
  return chunks;
}

// ─── Event Types ─────────────────────────────────────────────────────

export type WhatsAppConnectionEvent =
  | { type: 'qr'; channelId: string; qr: string }
  | { type: 'connected'; channelId: string; phoneNumber?: string }
  | { type: 'disconnected'; channelId: string; reason: 'logged_out' | 'connection_lost' };
