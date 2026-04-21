// ─────────────────────────────────────────────────────────────────────────────
// Global configuration — change values here or via environment variables.
// All durations are in milliseconds unless the variable name ends in _MIN.
// ─────────────────────────────────────────────────────────────────────────────

// ── WhatsApp do dono ──────────────────────────────────────────────────────────
// Fallback para quando o ownerPhone ainda não está no banco.
// Na maioria dos casos o sistema usa business.ownerPhone do banco de dados.
export const OWNER_PHONE = process.env.OWNER_PHONE ?? '';

// ── Alertas de entrega sem motoboy ────────────────────────────────────────────
// Minutos antes da entrega para alertar o dono se nenhum motoboy aceitou.
export const ALERT_BEFORE_DELIVERY_MIN = Number(process.env.ALERT_BEFORE_DELIVERY_MIN ?? 30);
// Atraso mínimo (minutos) para qualquer alerta — evita disparar imediatamente.
export const ALERT_MIN_DELAY_MIN = Number(process.env.ALERT_MIN_DELAY_MIN ?? 5);

// Versões em ms para uso interno
export const ALERT_BEFORE_DELIVERY_MS = ALERT_BEFORE_DELIVERY_MIN * 60_000;
export const ALERT_MIN_DELAY_MS = ALERT_MIN_DELAY_MIN * 60_000;

// ── AI / 9router ──────────────────────────────────────────────────────────────
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY ?? 'no-key';
export const OPENAI_BASE_URL = (() => {
  const raw = process.env.OPENAI_BASE_URL ?? 'http://localhost:20128';
  return raw.endsWith('/v1') ? raw : `${raw.replace(/\/$/, '')}/v1`;
})();
export const MODEL_NAME = process.env.MODEL_NAME ?? 'gpt-4.5';

// ── MercadoPago ───────────────────────────────────────────────────────────────
export const MP_ACCESS_TOKEN = process.env.MERCADOPAGO_ACCESS_TOKEN ?? '';
export const MP_WEBHOOK_URL = process.env.MP_WEBHOOK_URL ?? '';
export const MP_STATEMENT_NAME = process.env.MP_STATEMENT_NAME ?? 'Salgaderia';

// ── Servidor ──────────────────────────────────────────────────────────────────
export const PORT = Number(process.env.PORT ?? 3000);
export const APP_URL = process.env.APP_URL ?? 'http://localhost:3000';

// ── Google Calendar ───────────────────────────────────────────────────────────
export const GOOGLE_CALENDAR_ID = process.env.GOOGLE_CALENDAR_ID ?? '';
export const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON ?? '';

// ── Impressora térmica ────────────────────────────────────────────────────────
export const PRINTER_ENABLED = process.env.PRINTER_ENABLED === 'true';
export const PRINTER_TYPE = (process.env.PRINTER_TYPE ?? 'network') as 'network' | 'bluetooth' | 'usb';
export const PRINTER_ADDRESS = process.env.PRINTER_ADDRESS ?? '192.168.1.100';
export const PRINTER_PORT = Number(process.env.PRINTER_PORT ?? 9100);
