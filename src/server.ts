import 'dotenv/config';
import Fastify from 'fastify';
import { connect, setMessageHandler } from './whatsapp/client';
import { processMessage } from './agent/agent';
import { prisma } from './db/client';

const app = Fastify({
  logger: {
    level: 'info',
    serializers: { req: (req) => ({ method: req.method, url: req.url }) },
  },
  disableRequestLogging: false,
});

app.addHook('onRequest', async (req, reply) => {
  if (req.url.startsWith('/socket.io')) {
    reply.status(200).send('');
  }
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

app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

app.post<{ Body: { phone: string; message: string } }>('/send', async (req, reply) => {
  const { phone, message } = req.body;
  if (!phone || !message) return reply.status(400).send({ error: 'phone e message obrigatórios' });
  const { sendMessage } = await import('./whatsapp/client');
  await sendMessage(phone, message);
  return { sent: true };
});

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

app.get<{ Querystring: { phone?: string } }>('/orders', async (req) => {
  const id = await resolveBusinessId();
  const { phone } = req.query;
  return prisma.order.findMany({
    where: { businessId: id, ...(phone ? { phone } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
});

app.get('/conversations', async () => {
  const id = await resolveBusinessId();
  return prisma.conversation.findMany({
    where: { businessId: id },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { updatedAt: 'desc' },
  });
});

async function main() {
  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  console.log(`🚀 Servidor rodando na porta ${process.env.PORT ?? 3000}`);

  const id = await resolveBusinessId();
  if (!id) {
    console.warn('⚠️  Nenhum negócio cadastrado. Faça POST /business para configurar.');
  }

  setMessageHandler(async (phone: string, text: string) => {
    const bid = await resolveBusinessId();
    if (!bid) return 'Sistema em configuração. Tente novamente em breve.';
    return processMessage(phone, text, bid);
  });

  console.log('📲 Iniciando WhatsApp...');
  await connect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
