/**
 * Type declarations for @whiskeysockets/baileys
 *
 * Provides minimal type coverage for the WhatsApp connector.
 * This library has incomplete TypeScript declarations, so we provide
 * the essential types needed for our implementation.
 *
 * Note: Uses `any` for untyped third-party library internals where
 * proper types are not available from the library itself.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
// biome-ignore lint/suspicious/noExplicitAny: Third-party library has incomplete type definitions
declare module '@whiskeysockets/baileys' {
  export interface WASocket {
    user?: {
      id: string;
      name?: string;
    };
    logger?: any;
    ev: {
      on(event: 'connection.update', handler: (update: ConnectionUpdate) => void): void;
      on(event: 'creds.update', handler: () => void): void;
      on(event: 'messages.upsert', handler: (data: MessagesUpsert) => void): void;
      removeAllListeners(event: string): void;
    };
    sendMessage(
      jid: string,
      content: { text: string },
      options?: any
    ): Promise<{ key?: { id?: string } }>;
    readMessages(keys: Array<{ id?: string; fromMe?: boolean; remoteJid?: string }>): Promise<void>;
    end(error: any): void;
  }

  export interface ConnectionUpdate {
    connection?: 'open' | 'connecting' | 'close';
    lastDisconnect?: {
      error?: Error & { output?: { statusCode?: number } };
      date: Date;
    };
    qr?: string;
    isNewLogin?: boolean;
  }

  export interface MessagesUpsert {
    messages: WAMessage[];
    type: string;
  }

  export interface WAMessage {
    key: {
      id?: string;
      fromMe?: boolean;
      remoteJid?: string;
      participant?: string;
    };
    message?: any;
    messageTimestamp?: number | { toNumber: () => number };
  }

  export interface AuthenticationState {
    creds: any;
    keys: any;
  }

  export enum DisconnectReason {
    badSession = 400,
    connectionClosed = 428,
    connectionLost = 408,
    connectionReplaced = 440,
    loggedOut = 401,
    restartRequired = 515,
    timedOut = 408,
  }

  export function useMultiFileAuthState(
    folder: string
  ): Promise<{
    state: AuthenticationState;
    saveCreds: () => Promise<void>;
  }>;

  export default function makeWASocket(config: {
    auth: AuthenticationState;
    browser?: [string, string, string];
    logger?: any;
    markOnlineOnConnect?: boolean;
    syncFullHistory?: boolean;
    getMessage?: (key: any) => Promise<any>;
  }): WASocket;
}
