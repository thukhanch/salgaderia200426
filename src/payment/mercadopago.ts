import { MP_ACCESS_TOKEN, MP_WEBHOOK_URL, MP_STATEMENT_NAME, APP_URL } from '../config';

const MP_BASE_URL = 'https://api.mercadopago.com';

interface OrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

export async function createPaymentLink(params: {
  orderId: string;
  items: OrderItem[];
  total: number;
  payerPhone: string;
  externalRef: string;
}): Promise<string | null> {
  if (!MP_ACCESS_TOKEN) return null;

  const body = {
    items: params.items.map(i => ({
      id: i.name.toLowerCase().replace(/\s+/g, '_'),
      title: i.name,
      quantity: i.quantity,
      unit_price: Number(i.unitPrice),
      currency_id: 'BRL',
    })),
    external_reference: params.externalRef,
    back_urls: {
      success: `${APP_URL}/payment/success`,
      failure: `${APP_URL}/payment/failure`,
    },
    auto_return: 'approved',
    notification_url: MP_WEBHOOK_URL || undefined,
    statement_descriptor: MP_STATEMENT_NAME,
    expires: true,
    expiration_date_from: new Date().toISOString(),
    expiration_date_to: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(), // 24h
  };

  const res = await fetch(`${MP_BASE_URL}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const err = await res.text();
    console.error('MercadoPago erro:', err);
    return null;
  }

  const data = await res.json() as any;
  return data.init_point as string;
}

export async function getPaymentStatus(paymentId: string): Promise<string | null> {
  if (!MP_ACCESS_TOKEN) return null;

  const res = await fetch(`${MP_BASE_URL}/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${MP_ACCESS_TOKEN}` },
  });

  if (!res.ok) return null;
  const data = await res.json() as any;
  return data.status as string;
}

export function isEnabled(): boolean {
  return !!MP_ACCESS_TOKEN;
}
