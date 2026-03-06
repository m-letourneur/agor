/**
 * Minimal WhatsApp connection test
 * Run: node test-whatsapp.js
 */

import makeWASocket, { useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const TEST_CREDS_DIR = join(homedir(), '.agor', 'credentials', 'whatsapp-test');

async function testWhatsAppConnection() {
  console.log('🔍 Testing WhatsApp connection...');
  console.log(`📁 Credentials dir: ${TEST_CREDS_DIR}`);

  // Ensure directory exists
  mkdirSync(TEST_CREDS_DIR, { recursive: true });

  // Load or create auth state
  const { state, saveCreds } = await useMultiFileAuthState(TEST_CREDS_DIR);

  console.log('🔌 Creating socket...');

  const sock = makeWASocket({
    auth: state,
    browser: ['Chrome (Linux)', 'Chrome', '122.0.0'],
    printQRInTerminal: true, // Enable terminal QR for testing!
    logger: {
      level: 'info', // Enable more logging
      trace: (...args) => console.log('[TRACE]', ...args),
      debug: (...args) => console.log('[DEBUG]', ...args),
      info: (...args) => console.log('[INFO]', ...args),
      warn: (...args) => console.warn('[WARN]', ...args),
      error: (...args) => console.error('[ERROR]', ...args),
      fatal: (...args) => console.error('[FATAL]', ...args),
      child: function() { return this; },
    },
    connectTimeoutMs: 60_000,
    defaultQueryTimeoutMs: 60_000,
    // Workaround for error 405 - specify explicit WA version
    // See: https://github.com/WhiskeySockets/Baileys/issues/2370
    version: [2, 3000, 1033893291],
  });

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    console.log('\n📊 Connection Update:', {
      connection,
      hasQR: !!qr,
      hasError: !!lastDisconnect?.error,
    });

    if (qr) {
      console.log('\n✅ QR CODE GENERATED! Scan it above ☝️\n');
    }

    if (connection === 'open') {
      console.log('\n🎉 Connected successfully!');
      console.log('User:', sock.user);
      process.exit(0);
    }

    if (connection === 'close') {
      const error = lastDisconnect?.error;
      const statusCode = error?.output?.statusCode;

      console.error('\n❌ Connection closed!');
      console.error('Status Code:', statusCode);
      console.error('Error:', error?.message);

      if (error) {
        console.error('\nFull error details:');
        console.error(error);
      }

      if (statusCode === DisconnectReason.loggedOut) {
        console.log('\n🔓 Logged out - need to re-pair');
      }

      process.exit(1);
    }
  });

  sock.ev.on('creds.update', saveCreds);

  console.log('⏳ Waiting for connection...\n');
}

// Run test
testWhatsAppConnection().catch((err) => {
  console.error('\n💥 Test failed:', err);
  process.exit(1);
});
