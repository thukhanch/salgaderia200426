import 'dotenv/config';
import Fastify from 'fastify';
import { connect, setMessageHandler, setMotoboyHandler } from './whatsapp/client';
import { processMessage } from './agent/agent';
import { prisma } from './db/client';
import { isMotoboy, processMoboyMessage } from './motoboy/motoboy.service';
import { getPaymentStatus } from './payment/mercadopago';

const app = Fastify({
  logger: { level: 'info' },
});

let businessId = process.env.BUSINESS_ID ?? '';

async function resolveBusinessId(): Promise<string> {
  if (businessId) return businessId;
  const business = await prisma.business.findFirst({ where: { active: true } });
  if (business) {
    businessId = business.id;
    console.log(`✅ Negócio detectado automaticamente: "${business.name}" (${business.id})`);
  }
  return businessId;
}

// Silencia requisições socket.io do frontend antigo
app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/socket.io')) {
    reply.status(200).send('');
  }
});

// ── Health ────────────────────────────────────────────────────────────────────
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// ── Negócio ───────────────────────────────────────────────────────────────────
app.post<{ Body: any }>('/business', async (req, reply) => {
  const { name, ownerPhone, description, hours, menu, config } = req.body;
  if (!name || !ownerPhone) return reply.status(400).send({ error: 'name e ownerPhone obrigatórios' });

  const id = await resolveBusinessId();
  const business = await prisma.business.upsert({
    where: { id: id || 'placeholder' },
    create: { name, ownerPhone, description, hours: hours ?? {}, menu: menu ?? [], config: config ?? {} },
    update: { name, ownerPhone, description, hours, menu, config },
  });

  businessId = business.id;
  console.log(`✅ Negócio configurado: "${business.name}" (${business.id})`);
  return business;
});

app.get('/business', async () => {
  const id = await resolveBusinessId();
  return prisma.business.findUnique({ where: { id } });
});

// ── Motoboys ──────────────────────────────────────────────────────────────────
app.get('/motoboys', async () => {
  const id = await resolveBusinessId();
  return prisma.motoboy.findMany({ where: { businessId: id } });
});

app.post<{ Body: { name: string; phone: string } }>('/motoboys', async (req, reply) => {
  const { name, phone } = req.body;
  if (!name || !phone) return reply.status(400).send({ error: 'name e phone obrigatórios' });
  const id = await resolveBusinessId();
  if (!id) return reply.status(400).send({ error: 'Negócio não configurado' });

  const motoboy = await prisma.motoboy.upsert({
    where: { businessId_phone: { businessId: id, phone } },
    create: { businessId: id, name, phone },
    update: { name, active: true },
  });
  return motoboy;
});

app.delete<{ Params: { phone: string } }>('/motoboys/:phone', async (req, reply) => {
  const id = await resolveBusinessId();
  await prisma.motoboy.updateMany({
    where: { businessId: id, phone: req.params.phone },
    data: { active: false },
  });
  return { removed: true };
});

// ── Pedidos ───────────────────────────────────────────────────────────────────
app.get<{ Querystring: { phone?: string; status?: string } }>('/orders', async (req) => {
  const id = await resolveBusinessId();
  const { phone, status } = req.query;
  return prisma.order.findMany({
    where: { businessId: id, ...(phone ? { phone } : {}), ...(status ? { status } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
});

// ── Conversas ─────────────────────────────────────────────────────────────────
app.get('/conversations', async () => {
  const id = await resolveBusinessId();
  return prisma.conversation.findMany({
    where: { businessId: id },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { updatedAt: 'desc' },
  });
});

// ── Reiniciar conversa (handoff encerrado) ────────────────────────────────────
app.post<{ Params: { phone: string } }>('/conversations/:phone/reopen', async (req) => {
  const id = await resolveBusinessId();
  await prisma.conversation.updateMany({
    where: { businessId: id, phone: req.params.phone },
    data: { status: 'active' },
  });
  return { reopened: true };
});

// ── MercadoPago Webhook ───────────────────────────────────────────────────────
app.post<{ Body: any }>('/payment/webhook', async (req, reply) => {
  const { type, data } = req.body ?? {};
  if (type !== 'payment' || !data?.id) return reply.status(200).send('ok');

  const paymentId = String(data.id);
  const status = await getPaymentStatus(paymentId);
  if (!status) return reply.status(200).send('ok');

  const order = await prisma.order.findFirst({ where: { paymentId } });
  if (!order) {
    // Tenta pelo externalRef
    const orderByRef = await prisma.order.findFirst({ where: { id: { contains: paymentId.slice(-6) } } });
    if (orderByRef) {
      await prisma.order.update({
        where: { id: orderByRef.id },
        data: { paymentStatus: status, paymentId },
      });
    }
    return reply.status(200).send('ok');
  }

  await prisma.order.update({ where: { id: order.id }, data: { paymentStatus: status } });
  console.log(`💳 Pagamento ${paymentId} → ${status} (pedido #${order.id.slice(-6).toUpperCase()})`);
  return reply.status(200).send('ok');
});

app.get('/payment/success', async () => ({ message: 'Pagamento realizado! Obrigado.' }));
app.get('/payment/failure', async () => ({ message: 'Pagamento não aprovado. Tente novamente.' }));

// ── Envio manual (testes) ─────────────────────────────────────────────────────
app.post<{ Body: { phone: string; message: string } }>('/send', async (req, reply) => {
  const { phone, message } = req.body;
  if (!phone || !message) return reply.status(400).send({ error: 'phone e message obrigatórios' });
  const { sendMessage } = await import('./whatsapp/client');
  await sendMessage(phone, message);
  return { sent: true };
});

// ── Bootstrap ─────────────────────────────────────────────────────────────────
async function main() {
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  console.log(`🚀 Servidor rodando na porta ${process.env.PORT ?? 3000}`);

  const id = await resolveBusinessId();
  if (!id) {
    console.warn('⚠️  Nenhum negócio cadastrado. Faça POST /business para configurar.');
  }

  setMessageHandler(async (phone, text) => {
    const bid = await resolveBusinessId();
    if (!bid) return 'Sistema em configuração. Tente novamente em breve.';
    return processMessage(phone, text, bid);
  });

  if (id) {
    setMotoboyHandler(processMoboyMessage, isMotoboy, id);
    console.log('🛵 Sistema de motoboys ativo');
  }

  console.log('📲 Iniciando WhatsApp...');
  await connect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
