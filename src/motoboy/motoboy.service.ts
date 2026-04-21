import { prisma } from '../db/client';
import { sendMessage } from '../whatsapp/client';

// Mapa em memória: orderId -> Set de motoboys notificados, para controle de corrida
const pendingDeliveries = new Map<string, { businessId: string; accepted: boolean }>();

function formatDeliveryAlert(order: any): string {
  const items = (order.items as any[]).map(i => `• ${i.quantity}x ${i.name}`).join('\n');
  const scheduledAt = order.scheduledAt
    ? new Date(order.scheduledAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'A combinar';

  return (
    `🛵 *NOVA ENTREGA DISPONÍVEL!*\n\n` +
    `Pedido: #${order.id.slice(-6).toUpperCase()}\n` +
    `📦 Itens:\n${items}\n\n` +
    `📍 Endereço: ${order.address}\n` +
    `📅 Horário: ${scheduledAt}\n` +
    `💰 Total do pedido: R$ ${Number(order.total).toFixed(2)}\n\n` +
    `Responda *OK* para aceitar esta entrega.\n` +
    `⚡ Primeiro a responder confirma a corrida!`
  );
}

export async function notifyMotoboys(order: any): Promise<void> {
  const motoboys = await prisma.motoboy.findMany({
    where: { businessId: order.businessId, active: true },
  });

  if (motoboys.length === 0) {
    console.warn(`⚠️  Nenhum motoboy cadastrado para o negócio ${order.businessId}`);
    return;
  }

  pendingDeliveries.set(order.id, { businessId: order.businessId, accepted: false });

  const msg = formatDeliveryAlert(order);
  for (const motoboy of motoboys) {
    try {
      await sendMessage(motoboy.phone, msg);
      console.log(`📨 Motoboy ${motoboy.name} (${motoboy.phone}) notificado`);
    } catch {
      console.error(`❌ Erro ao notificar motoboy ${motoboy.name}`);
    }
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { motoboyStatus: 'notified' },
  });
}

export async function isMotoboy(phone: string, businessId: string): Promise<boolean> {
  const count = await prisma.motoboy.count({ where: { phone, businessId, active: true } });
  return count > 0;
}

export async function processMoboyMessage(
  phone: string,
  text: string,
  businessId: string,
): Promise<void> {
  const normalized = text.trim().toLowerCase();
  const isAcceptance = ['ok', 'sim', 'aceito', 'aceitar', 'pego', 'vou', 'confirmo'].some(w =>
    normalized.includes(w),
  );

  if (!isAcceptance) {
    await sendMessage(phone, 'Para aceitar uma entrega, responda *OK* quando receber o alerta. 🛵');
    return;
  }

  // Encontra pedido pendente para este negócio que ainda não foi aceito
  const order = await prisma.order.findFirst({
    where: {
      businessId,
      motoboyStatus: 'notified',
      deliveryType: 'delivery',
    },
    orderBy: { createdAt: 'desc' },
  });

  if (!order) {
    await sendMessage(phone, 'Nenhuma entrega pendente no momento. Aguarde o próximo aviso! 👍');
    return;
  }

  const pending = pendingDeliveries.get(order.id);
  if (!pending || pending.accepted) {
    await sendMessage(phone, 'Essa entrega já foi aceita por outro motoboy. Aguarde o próximo! 🏃');
    return;
  }

  // Marca como aceito imediatamente (corrida)
  pending.accepted = true;

  const motoboy = await prisma.motoboy.findUnique({ where: { businessId_phone: { businessId, phone } } });
  const motoboyName = motoboy?.name ?? phone;

  await prisma.order.update({
    where: { id: order.id },
    data: {
      motoboyPhone: phone,
      motoboyName: motoboyName,
      motoboyStatus: 'accepted',
    },
  });

  // Confirma para o motoboy
  const items = (order.items as any[]).map(i => `${i.quantity}x ${i.name}`).join(', ');
  await sendMessage(
    phone,
    `✅ *Entrega confirmada para você, ${motoboyName}!*\n\n` +
      `Pedido: #${order.id.slice(-6).toUpperCase()}\n` +
      `📦 ${items}\n` +
      `📍 ${order.address}\n\n` +
      `Boa entrega! 🛵💨`,
  );

  // Notifica o cliente
  try {
    await sendMessage(
      order.phone,
      `🛵 *Seu pedido saiu para entrega!*\n` +
        `Motoboy: ${motoboyName}\n` +
        `Em breve chegará até você! 😊`,
    );
  } catch {
    // Notificação ao cliente é opcional
  }

  // Avisa outros motoboys que já foi aceito
  const others = await prisma.motoboy.findMany({
    where: { businessId, active: true, NOT: { phone } },
  });
  for (const other of others) {
    try {
      await sendMessage(other.phone, `ℹ️ O pedido #${order.id.slice(-6).toUpperCase()} já foi aceito por outro motoboy.`);
    } catch {
      // Ignora erro de notificação
    }
  }

  pendingDeliveries.delete(order.id);
  console.log(`✅ Entrega #${order.id.slice(-6).toUpperCase()} aceita por ${motoboyName}`);
}
