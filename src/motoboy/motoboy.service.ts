import { prisma } from '../db/client';
import { sendMessage } from '../whatsapp/client';

// Cache em memória dos telefones de motoboys (evita query no banco a cada mensagem)
const motoboyPhoneCache = new Map<string, Set<string>>(); // businessId -> Set<phone>
let cacheExpiry = 0;
const CACHE_TTL = 60_000; // 1 minuto

async function getMotoboyPhones(businessId: string): Promise<Set<string>> {
  const now = Date.now();
  if (now < cacheExpiry && motoboyPhoneCache.has(businessId)) {
    return motoboyPhoneCache.get(businessId)!;
  }

  const motoboys = await prisma.motoboy.findMany({
    where: { businessId, active: true },
    select: { phone: true },
  });

  const phones = new Set(motoboys.map(m => m.phone));
  motoboyPhoneCache.set(businessId, phones);
  cacheExpiry = now + CACHE_TTL;
  return phones;
}

export function invalidateMotoboyCache() {
  motoboyPhoneCache.clear();
  cacheExpiry = 0;
}

export async function isMotoboy(phone: string, businessId: string): Promise<boolean> {
  const phones = await getMotoboyPhones(businessId);
  return phones.has(phone);
}

function formatDeliveryAlert(order: any, index?: number, total?: number): string {
  const items = (order.items as any[]).map(i => `• ${i.quantity}x ${i.name}`).join('\n');
  const scheduledAt = order.scheduledAt
    ? new Date(order.scheduledAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'A combinar';
  const counter = total && total > 1 ? ` (${index}/${total})` : '';

  return (
    `🛵 *NOVA ENTREGA DISPONÍVEL${counter}!*\n\n` +
    `Pedido: #${order.id.slice(-6).toUpperCase()}\n` +
    `📦 Itens:\n${items}\n\n` +
    `📍 ${order.address}\n` +
    `📅 ${scheduledAt}\n` +
    `💰 R$ ${Number(order.total).toFixed(2)}\n\n` +
    `Responda *OK ${order.id.slice(-6).toUpperCase()}* para aceitar.\n` +
    `⚡ Primeiro a responder confirma a corrida!`
  );
}

export async function notifyMotoboys(order: any): Promise<void> {
  const motoboys = await prisma.motoboy.findMany({
    where: { businessId: order.businessId, active: true },
  });

  if (motoboys.length === 0) {
    console.warn(`⚠️  Nenhum motoboy cadastrado para o negócio ${order.businessId}`);

    // Avisa o dono que não há motoboys
    const business = await prisma.business.findUnique({ where: { id: order.businessId } });
    if (business?.ownerPhone) {
      await sendMessage(
        business.ownerPhone,
        `⚠️ Pedido #${order.id.slice(-6).toUpperCase()} é uma entrega mas *não há motoboys cadastrados*!\nCadastre motoboys via /motoboys ou atribua manualmente.`,
      );
    }
    return;
  }

  const msg = formatDeliveryAlert(order);

  for (const motoboy of motoboys) {
    try {
      await sendMessage(motoboy.phone, msg);
      console.log(`📨 Motoboy ${motoboy.name} notificado`);
    } catch {
      console.error(`❌ Falha ao notificar motoboy ${motoboy.name}`);
    }
  }

  await prisma.order.update({
    where: { id: order.id },
    data: { motoboyStatus: 'notified' },
  });

  // Timeout: se ninguém aceitar em 5 min, escalona pro dono
  scheduleEscalation(order.id, order.businessId);
}

function scheduleEscalation(orderId: string, businessId: string) {
  const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutos

  setTimeout(async () => {
    const order = await prisma.order.findUnique({ where: { id: orderId } });
    if (!order || order.motoboyStatus !== 'notified') return; // Já foi aceito

    console.warn(`⏰ Pedido #${orderId.slice(-6).toUpperCase()} sem motoboy após 5 min — escalando`);

    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (business?.ownerPhone) {
      const items = (order.items as any[]).map(i => `${i.quantity}x ${i.name}`).join(', ');
      await sendMessage(
        business.ownerPhone,
        `⚠️ *Atenção! Nenhum motoboy aceitou a entrega em 5 minutos.*\n\n` +
          `Pedido: #${orderId.slice(-6).toUpperCase()}\n` +
          `📦 ${items}\n` +
          `📍 ${order.address}\n\n` +
          `Por favor, atribua um motoboy manualmente.`,
      );
    }
  }, TIMEOUT_MS);
}

function parseAcceptance(text: string): { accepted: boolean; orderId?: string } {
  const normalized = text.trim().toLowerCase().replace(/[^\w\s]/g, '');
  const words = normalized.split(/\s+/);

  const acceptWords = ['ok', 'sim', 'aceito', 'aceitar', 'pego', 'confirmo', 'quero'];
  const firstWord = words[0] ?? '';

  if (!acceptWords.includes(firstWord)) {
    return { accepted: false };
  }

  // Tenta extrair ID do pedido (ex: "OK ABC123" ou "ok ab1c2d")
  const idPattern = /\b([a-z0-9]{6})\b/i;
  const match = text.match(idPattern);
  const orderId = match ? match[1].toUpperCase() : undefined;

  return { accepted: true, orderId };
}

export async function processMoboyMessage(
  phone: string,
  text: string,
  businessId: string,
): Promise<void> {
  const { accepted, orderId } = parseAcceptance(text);

  if (!accepted) {
    // Mensagem genérica — verifica se há pedidos pendentes antes de responder
    const hasPending = await prisma.order.count({
      where: { businessId, motoboyStatus: 'notified', deliveryType: 'delivery' },
    });
    if (hasPending > 0) {
      await sendMessage(
        phone,
        `Há ${hasPending} entrega(s) aguardando. Responda *OK <ID>* para aceitar.\nEx: OK ABC123`,
      );
    }
    return;
  }

  // Encontra o pedido correto
  let order: any = null;

  if (orderId) {
    // Busca pelo ID informado
    order = await prisma.order.findFirst({
      where: {
        businessId,
        motoboyStatus: 'notified',
        deliveryType: 'delivery',
        id: { endsWith: orderId.toLowerCase() },
      },
    });
  } else {
    // Sem ID — pega o mais recente
    order = await prisma.order.findFirst({
      where: { businessId, motoboyStatus: 'notified', deliveryType: 'delivery' },
      orderBy: { createdAt: 'desc' },
    });
  }

  if (!order) {
    await sendMessage(phone, 'Nenhuma entrega pendente no momento. Aguarde o próximo aviso! 👍');
    return;
  }

  // Aceite atômico via banco — evita race condition
  // updateMany retorna count=0 se outro motoboy já aceitou
  const motoboy = await prisma.motoboy.findUnique({
    where: { businessId_phone: { businessId, phone } },
  });
  const motoboyName = motoboy?.name ?? phone;

  const updated = await prisma.order.updateMany({
    where: { id: order.id, motoboyStatus: 'notified' }, // condição atômica
    data: {
      motoboyPhone: phone,
      motoboyName: motoboyName,
      motoboyStatus: 'accepted',
    },
  });

  if (updated.count === 0) {
    // Outro motoboy ganhou a corrida
    await sendMessage(phone, '🏃 Essa entrega já foi aceita por outro motoboy. Aguarde o próximo!');
    return;
  }

  const items = (order.items as any[]).map(i => `${i.quantity}x ${i.name}`).join(', ');
  const ordShort = order.id.slice(-6).toUpperCase();

  // Confirma para o motoboy
  await sendMessage(
    phone,
    `✅ *Entrega #${ordShort} confirmada para você, ${motoboyName}!*\n\n` +
      `📦 ${items}\n` +
      `📍 ${order.address}\n\n` +
      `Quando concluir, responda *ENTREGUE ${ordShort}*. Boa corrida! 🛵💨`,
  );

  // Avisa outros motoboys
  const others = await prisma.motoboy.findMany({
    where: { businessId, active: true, NOT: { phone } },
  });
  for (const other of others) {
    try {
      await sendMessage(other.phone, `ℹ️ Pedido #${ordShort} foi aceito. Aguarde o próximo!`);
    } catch { /* opcional */ }
  }

  // Notifica cliente
  try {
    await sendMessage(
      order.phone,
      `🛵 *Seu pedido saiu para entrega!*\nMotoboy: ${motoboyName}\nChegando em breve! 😊`,
    );
  } catch { /* opcional */ }

  // Notifica dono
  try {
    const business = await prisma.business.findUnique({ where: { id: businessId } });
    if (business?.ownerPhone) {
      await sendMessage(
        business.ownerPhone,
        `🛵 Motoboy *${motoboyName}* aceitou o pedido #${ordShort}.`,
      );
    }
  } catch { /* opcional */ }

  console.log(`✅ Entrega #${ordShort} aceita por ${motoboyName}`);

  // Verifica entrega concluída
  if (text.toUpperCase().includes('ENTREGUE')) {
    await handleDeliveryComplete(phone, text, businessId);
  }
}

async function handleDeliveryComplete(phone: string, text: string, businessId: string) {
  const idMatch = text.match(/ENTREGUE\s+([A-Z0-9]{6})/i);
  const order = idMatch
    ? await prisma.order.findFirst({
        where: { businessId, motoboyPhone: phone, id: { endsWith: idMatch[1].toLowerCase() } },
      })
    : await prisma.order.findFirst({
        where: { businessId, motoboyPhone: phone, motoboyStatus: 'accepted' },
        orderBy: { updatedAt: 'desc' },
      });

  if (!order) return;

  await prisma.order.update({
    where: { id: order.id },
    data: { motoboyStatus: 'delivered', status: 'delivered' },
  });

  const ordShort = order.id.slice(-6).toUpperCase();
  await sendMessage(phone, `🎉 Entrega #${ordShort} marcada como concluída! Obrigado, ${phone}!`);

  try {
    await sendMessage(order.phone, `✅ Entrega confirmada! Obrigado pela preferência. 😊`);
  } catch { /* opcional */ }
}
