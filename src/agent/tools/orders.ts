import { prisma } from '../../db/client';
import { createEvent } from '../../calendar/google';
import { sendMessage } from '../../whatsapp/client';

interface OrderItem {
  name: string;
  quantity: number;
  unitPrice: number;
}

interface CreateOrderParams {
  businessId: string;
  phone: string;
  items: OrderItem[];
  scheduledAt?: string;
  deliveryType?: 'pickup' | 'delivery';
  address?: string;
  notes?: string;
}

export async function createOrder(params: CreateOrderParams) {
  const total = params.items.reduce((sum, i) => sum + i.quantity * i.unitPrice, 0);

  const order = await prisma.order.create({
    data: {
      businessId: params.businessId,
      phone: params.phone,
      items: params.items as any,
      total,
      scheduledAt: params.scheduledAt ? new Date(params.scheduledAt) : null,
      deliveryType: params.deliveryType ?? null,
      address: params.address ?? null,
      notes: params.notes ?? null,
      status: 'confirmed',
    },
    include: { business: true },
  });

  // Cria evento no Google Calendar
  if (order.scheduledAt) {
    const itemsSummary = params.items.map(i => `${i.quantity}x ${i.name}`).join(', ');
    try {
      const eventId = await createEvent({
        title: `Pedido #${order.id.slice(-6).toUpperCase()} - ${order.business.name}`,
        description: `Cliente: ${params.phone}\nItens: ${itemsSummary}\nTotal: R$ ${total.toFixed(2)}\n${params.notes ?? ''}`,
        startTime: order.scheduledAt,
        location: params.address,
      });
      if (eventId) {
        await prisma.order.update({ where: { id: order.id }, data: { calendarEventId: eventId } });
      }
    } catch {
      // Calendar é opcional
    }
  }

  // Notifica dono
  const ownerPhone = order.business.ownerPhone;
  if (ownerPhone) {
    const itemsSummary = params.items.map(i => `• ${i.quantity}x ${i.name} = R$ ${(i.quantity * i.unitPrice).toFixed(2)}`).join('\n');
    const msg =
      `🛒 *Novo pedido confirmado!*\n` +
      `Cliente: ${params.phone}\n` +
      `Pedido: #${order.id.slice(-6).toUpperCase()}\n\n` +
      `${itemsSummary}\n\n` +
      `*Total: R$ ${total.toFixed(2)}*` +
      (order.scheduledAt ? `\n📅 ${order.scheduledAt.toLocaleString('pt-BR')}` : '') +
      (params.address ? `\n📍 ${params.address}` : '');
    try {
      await sendMessage(ownerPhone, msg);
    } catch {
      // Notificação é opcional
    }
  }

  return {
    orderId: order.id.slice(-6).toUpperCase(),
    total,
    status: 'confirmed',
    scheduledAt: order.scheduledAt?.toISOString() ?? null,
  };
}

export async function getOrders(phone: string, businessId: string) {
  const orders = await prisma.order.findMany({
    where: { phone, businessId },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });
  return orders.map(o => ({
    id: o.id.slice(-6).toUpperCase(),
    items: o.items,
    total: o.total,
    status: o.status,
    scheduledAt: o.scheduledAt?.toISOString() ?? null,
    createdAt: o.createdAt.toISOString(),
  }));
}

export async function cancelOrder(orderId: string) {
  const order = await prisma.order.findFirst({ where: { id: { endsWith: orderId } } });
  if (!order) return { success: false, message: 'Pedido não encontrado' };

  await prisma.order.update({ where: { id: order.id }, data: { status: 'cancelled' } });
  return { success: true, message: `Pedido #${orderId} cancelado` };
}
