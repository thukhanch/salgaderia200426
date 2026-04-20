import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  makeCacheableSignalKeyStore,
  WASocket,
} from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import qrcode from 'qrcode-terminal';
import pino from 'pino';
import path from 'path';
import fs from 'fs';

type MessageHandler = (phone: string, text: string) => Promise<string>;

const AUTH_DIR = path.join(process.cwd(), 'auth_state');
const logger = pino({ level: 'silent' });

let sock: WASocket | null = null;
let messageHandler: MessageHandler | null = null;

export function setMessageHandler(handler: MessageHandler) {
  messageHandler = handler;
}

export async function sendMessage(phone: string, text: string) {
  if (!sock) throw new Error('WhatsApp não conectado');
  const jid = phone.includes('@') ? phone : `${phone}@s.whatsapp.net`;
  await sock.sendMessage(jid, { text });
}

export async function connect() {
  if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  const { version } = await fetchLatestBaileysVersion();

  sock = makeWASocket({
    version,
    logger,
    auth: {
      creds: state.creds,
      keys: makeCacheableSignalKeyStore(state.keys, logger),
    },
    generateHighQualityLinkPreview: false,
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      console.log('\n📱 Escaneie o QR code abaixo com seu WhatsApp:\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const shouldReconnect =
        (lastDisconnect?.error as Boom)?.output?.statusCode !== DisconnectReason.loggedOut;

      if (shouldReconnect) {
        console.log('🔄 Reconectando ao WhatsApp...');
        setTimeout(connect, 3000);
      } else {
        console.log('🚪 Desconectado permanentemente. Delete a pasta auth_state e reinicie.');
      }
    }

    if (connection === 'open') {
      console.log('✅ WhatsApp conectado com sucesso!');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;

    for (const msg of messages) {
      if (msg.key.fromMe) continue;
      if (!msg.message) continue;

      const phone = msg.key.remoteJid?.replace('@s.whatsapp.net', '') ?? '';
      if (!phone) continue;

      const text =
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        '';

      if (!text.trim()) continue;

      console.log(`📩 [${phone}]: ${text}`);

      if (messageHandler) {
        try {
          const response = await messageHandler(phone, text);
          if (response) {
            await sendMessage(phone, response);
            console.log(`📤 [${phone}]: ${response.slice(0, 80)}...`);
          }
        } catch (err) {
          console.error('Erro ao processar mensagem:', err);
          await sendMessage(phone, '⚠️ Ocorreu um erro. Tente novamente em instantes.');
        }
      }
    }
  });
}
