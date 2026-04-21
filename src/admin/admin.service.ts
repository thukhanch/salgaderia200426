import { prisma } from '../db/client';
import { sendMessage } from '../whatsapp/client';
import { invalidateMotoboyCache } from '../motoboy/motoboy.service';

const HELP_TEXT = `🔧 *Painel do Dono — Comandos disponíveis*

*Motoboys:*
• \`motoboy add <nome> <telefone>\`
  _Adiciona um motoboy_
• \`motoboy remover <telefone>\`
  _Remove um motoboy_
• \`motoboys\`
  _Lista todos os motoboys_

*Pedidos:*
• \`pedidos\`
  _Últimos 10 pedidos_
• \`pedido <ID>\`
  _Detalhes de um pedido_

*Conversas:*
• \`reabrir <telefone>\`
  _Reabre conversa em handoff_

*Cardápio:*
• \`cardapio\`
  _Exibe o cardápio atual_

Digite \`ajuda\` a qualquer momento para ver esta lista.`;

export async function isOwner(phone: string, businessId: string): Promise<boolean> {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) return false;
  // Normaliza ambos os números (remove +, espaços, traços)
  const normalize = (p: string) => p.replace(/[\s+\-()]/g, '');
  return normalize(business.ownerPhone) === normalize(phone);
}

export async function processOwnerCommand(
  phone: string,
  text: string,
  businessId: string,
): Promise<void> {
  const raw = text.trim();
  const lower = raw.toLowerCase();
  const parts = raw.trim().split(/\s+/);
  const cmd = parts[0]?.toLowerCase() ?? '';

  try {
    // ── ajuda ────────────────────────────────────────────────────────────────
    if (cmd === 'ajuda' || cmd === 'help' || cmd === 'menu') {
      await sendMessage(phone, HELP_TEXT);
      return;
    }

    // ── motoboys (listar) ────────────────────────────────────────────────────
    if (lower === 'motoboys' || lower === 'listar motoboys') {
      const list = await prisma.motoboy.findMany({ where: { businessId } });
      if (list.length === 0) {
        await sendMessage(phone, '📋 Nenhum motoboy cadastrado.\nUse: `motoboy add <nome> <telefone>`');
        return;
      }
      const lines = list.map(
        (m, i) =>
          `${i + 1}. *${m.name}* — ${m.phone} ${m.active ? '✅' : '❌ inativo'}`,
      );
      await sendMessage(phone, `🛵 *Motoboys cadastrados:*\n\n${lines.join('\n')}`);
      return;
    }

    // ── motoboy add <nome> <telefone> ────────────────────────────────────────
    if (cmd === 'motoboy' && parts[1]?.toLowerCase() === 'add') {
      if (parts.length < 4) {
        await sendMessage(phone, '⚠️ Uso correto:\n`motoboy add <nome> <telefone>`\n\nEx: `motoboy add João 5511999999999`');
        return;
      }
      const telefone = parts[parts.length - 1];
      const nome = parts.slice(2, parts.length - 1).join(' ');

      if (!/^\d{10,15}$/.test(telefone)) {
        await sendMessage(phone, `⚠️ Telefone inválido: *${telefone}*\nUse apenas números com DDD e DDI.\nEx: 5511999999999`);
        return;
      }

      await prisma.motoboy.upsert({
        where: { businessId_phone: { businessId, phone: telefone } },
        create: { businessId, name: nome, phone: telefone },
        update: { name: nome, active: true },
      });
      invalidateMotoboyCache();

      await sendMessage(phone, `✅ *${nome}* adicionado como motoboy!\nTelefone: ${telefone}`);
      return;
    }

    // ── motoboy remover <telefone> ───────────────────────────────────────────
    if (cmd === 'motoboy' && (parts[1]?.toLowerCase() === 'remover' || parts[1]?.toLowerCase() === 'remove')) {
      if (parts.length < 3) {
        await sendMessage(phone, '⚠️ Uso correto:\n`motoboy remover <telefone>`\n\nEx: `motoboy remover 5511999999999`');
        return;
      }
      const telefone = parts[2];
      const motoboy = await prisma.motoboy.findUnique({
        where: { businessId_phone: { businessId, phone: telefone } },
      });

      if (!motoboy) {
        await sendMessage(phone, `⚠️ Motoboy com telefone *${telefone}* não encontrado.\nUse \`motoboys\` para ver a lista.`);
        return;
      }

      await prisma.motoboy.update({
        where: { businessId_phone: { businessId, phone: telefone } },
        data: { active: false },
      });
      invalidateMotoboyCache();

      await sendMessage(phone, `🗑️ *${motoboy.name}* removido com sucesso.`);
      return;
    }

    // ── pedidos ──────────────────────────────────────────────────────────────
    if (cmd === 'pedidos') {
      const orders = await prisma.order.findMany({
        where: { businessId },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });

      if (orders.length === 0) {
        await sendMessage(phone, '📋 Nenhum pedido encontrado.');
        return;
      }

      const statusEmoji: Record<string, string> = {
        confirmed: '✅', pending: '⏳', cancelled: '❌', delivered: '🏁',
      };
      const lines = orders.map(o => {
        const emoji = statusEmoji[o.status] ?? '•';
        const date = o.scheduledAt
          ? new Date(o.scheduledAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' })
          : new Date(o.createdAt).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        return `${emoji} #${o.id.slice(-6).toUpperCase()} — R$${Number(o.total).toFixed(2)} — ${date}`;
      });

      await sendMessage(phone, `📋 *Últimos pedidos:*\n\n${lines.join('\n')}\n\nDigite \`pedido <ID>\` para detalhes.`);
      return;
    }

    // ── pedido <ID> ──────────────────────────────────────────────────────────
    if (cmd === 'pedido' && parts[1]) {
      const searchId = parts[1].toLowerCase();
      const order = await prisma.order.findFirst({
        where: { businessId, id: { endsWith: searchId } },
      });

      if (!order) {
        await sendMessage(phone, `⚠️ Pedido *#${parts[1].toUpperCase()}* não encontrado.`);
        return;
      }

      const items = (order.items as any[]).map(i => `• ${i.quantity}x ${i.name} = R$${(i.quantity * i.unitPrice).toFixed(2)}`).join('\n');
      const detail =
        `📦 *Pedido #${order.id.slice(-6).toUpperCase()}*\n\n` +
        `Cliente: ${order.phone}\n` +
        `Status: ${order.status}\n` +
        `Pagamento: ${order.paymentStatus ?? 'N/A'}\n` +
        (order.deliveryType === 'delivery'
          ? `Entrega: ${order.motoboyName ?? 'aguardando motoboy'}\n📍 ${order.address}\n`
          : `Tipo: Retirada\n`) +
        (order.scheduledAt ? `📅 ${new Date(order.scheduledAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n` : '') +
        `\n${items}\n\n` +
        `*Total: R$${Number(order.total).toFixed(2)}*`;

      await sendMessage(phone, detail);
      return;
    }

    // ── reabrir <telefone> ───────────────────────────────────────────────────
    if (cmd === 'reabrir' && parts[1]) {
      const clientPhone = parts[1];
      const updated = await prisma.conversation.updateMany({
        where: { businessId, phone: clientPhone },
        data: { status: 'active' },
      });

      if (updated.count === 0) {
        await sendMessage(phone, `⚠️ Nenhuma conversa encontrada para *${clientPhone}*.`);
        return;
      }

      await sendMessage(phone, `✅ Conversa com *${clientPhone}* reaberta. O cliente voltará a ser atendido pelo agente.`);
      return;
    }

    // ── cardapio ─────────────────────────────────────────────────────────────
    if (cmd === 'cardapio' || cmd === 'cardápio') {
      const business = await prisma.business.findUnique({ where: { id: businessId } });
      const menu = (business?.menu as any[]) ?? [];

      if (menu.length === 0) {
        await sendMessage(phone, '📋 Cardápio vazio. Atualize via POST /business.');
        return;
      }

      const lines = menu.map(i => `• *${i.name}*: R$ ${Number(i.price).toFixed(2)}${i.unit ? `/${i.unit}` : ''}${i.description ? ` — ${i.description}` : ''}`);
      await sendMessage(phone, `🍽️ *Cardápio atual:*\n\n${lines.join('\n')}`);
      return;
    }

    // ── comando desconhecido ─────────────────────────────────────────────────
    await sendMessage(
      phone,
      `❓ Comando não reconhecido: *${cmd}*\n\nDigite *ajuda* para ver os comandos disponíveis.`,
    );
  } catch (err: any) {
    console.error('Erro no painel do dono:', err);
    await sendMessage(phone, `❌ Erro ao executar comando: ${err.message}`);
  }
}
