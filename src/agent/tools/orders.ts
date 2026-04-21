import { prisma } from '../../db/client';
import { createEvent } from '../../calendar/google';
import { sendMessage } from '../../whatsapp/client';
import { notifyMotoboys } from '../../motoboy/motoboy.service';
import { createPaymentLink, isEnabled as mpEnabled } from '../../payment/mercadopago';
import { printOrder } from '../../printer/printer.service';

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
  // Validações de segurança
  if (!params.items || params.items.length === 0) {
    throw new Error('Pedido deve ter pelo menos um item');
  }
  for (const item of params.items) {
    if (item.quantity <= 0 || !Number.isFinite(item.quantity)) {
      throw new Error(`Quantidade inválida para "${item.name}": deve ser maior que zero`);
    }
    if (item.quantity > 2000) {
      throw new Error(`Quantidade de "${item.name}" excede o limite de 2000 unidades por pedido`);
    }
    if (item.unitPrice <= 0 || !Number.isFinite(item.unitPrice)) {
      throw new Error(`Preço inválido para "${item.name}"`);
    }
  }
  if (params.scheduledAt) {
    const scheduled = new Date(params.scheduledAt);
    const minDate = new Date(Date.now() + 60 * 60 * 1000);
    if (scheduled < minDate) {
      throw new Error('Data de agendamento deve ser pelo menos 1 hora no futuro');
    }
  }
  if (params.deliveryType === 'delivery' && !params.address) {
    throw new Error('Endereço é obrigatório para entrega');
  }

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
      paymentStatus: 'pending',
    },
    include: { business: true },
  });

  const orderId = order.id.slice(-6).toUpperCase();

  // 1. Google Calendar
  if (order.scheduledAt) {
    const itemsSummary = params.items.map(i => `${i.quantity}x ${i.name}`).join(', ');
    try {
      const eventId = await createEvent({
        title: `Pedido #${orderId} - ${order.business.name}`,
        description: `Cliente: ${params.phone}\nItens: ${itemsSummary}\nTotal: R$ ${total.toFixed(2)}\n${params.notes ?? ''}`,
        startTime: order.scheduledAt,
        location: params.address,
      });
      if (eventId) {
        await prisma.order.update({ where: { id: order.id }, data: { calendarEventId: eventId } });
      }
    } catch (e) {
      console.warn('Google Calendar (opcional):', e);
    }
  }

  // 2. MercadoPago — gera link de pagamento
  let paymentLink: string | null = null;
  if (mpEnabled()) {
    try {
      paymentLink = await createPaymentLink({
        orderId: order.id,
        items: params.items,
        total,
        payerPhone: params.phone,
        externalRef: order.id,
      });
      if (paymentLink) {
        await prisma.order.update({ where: { id: order.id }, data: { paymentLink } });
      }
    } catch (e) {
      console.warn('MercadoPago (opcional):', e);
    }
  }

  // 3. Impressora — imprime o ticket do pedido
  try {
    await printOrder({
      id: order.id,
      items: params.items,
      total,
      scheduledAt: order.scheduledAt,
      deliveryType: order.deliveryType,
      address: order.address,
      phone: params.phone,
      notes: order.notes,
      paymentStatus: order.paymentStatus,
      businessName: order.business.name,
    });
  } catch (e) {
    console.warn('Impressora (opcional):', e);
  }

  // 4. Notifica dono via WhatsApp
  const ownerPhone = order.business.ownerPhone;
  if (ownerPhone) {
    const itemsSummary = params.items
      .map(i => `• ${i.quantity}x ${i.name} = R$ ${(i.quantity * i.unitPrice).toFixed(2)}`)
      .join('\n');
    const msg =
      `🛒 *Novo pedido confirmado!*\n` +
      `Pedido: #${orderId}\n` +
      `Cliente: ${params.phone}\n\n` +
      `${itemsSummary}\n\n` +
      `*Total: R$ ${total.toFixed(2)}*` +
      (order.scheduledAt
        ? `\n📅 ${new Date(order.scheduledAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`
        : '') +
      (params.deliveryType === 'delivery' ? `\n🛵 Entrega em: ${params.address}` : '\n🏠 Retirada no local') +
      (paymentLink ? `\n💳 Pagamento: ${paymentLink}` : '');
    try {
      await sendMessage(ownerPhone, msg);
    } catch {
      // Notificação é opcional
    }
  }

  // 5. Motoboy — só aciona se for entrega
  if (order.deliveryType === 'delivery') {
    try {
      await notifyMotoboys(order);
    } catch (e) {
      console.warn('Notificação motoboy (opcional):', e);
    }
  }

  return {
    orderId,
    total,
    status: 'confirmed',
    scheduledAt: order.scheduledAt?.toISOString() ?? null,
    paymentLink,
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
    paymentStatus: o.paymentStatus,
    motoboyStatus: o.motoboyStatus,
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
