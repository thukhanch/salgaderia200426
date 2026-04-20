import 'dotenv/config';
import Fastify from 'fastify';
import { connect, setMessageHandler } from './whatsapp/client';
import { processMessage } from './agent/agent';
import { prisma } from './db/client';

const app = Fastify({ logger: { level: 'info' } });

const BUSINESS_ID = process.env.BUSINESS_ID ?? '';

// Health check
app.get('/health', async () => ({ status: 'ok', timestamp: new Date().toISOString() }));

// Endpoint para enviar mensagem manualmente (testes)
app.post<{ Body: { phone: string; message: string } }>('/send', async (req, reply) => {
  const { phone, message } = req.body;
  if (!phone || !message) return reply.status(400).send({ error: 'phone e message obrigatórios' });
  const { sendMessage } = await import('./whatsapp/client');
  await sendMessage(phone, message);
  return { sent: true };
});

// Endpoint para registrar/atualizar negócio
app.post<{ Body: any }>('/business', async (req, reply) => {
  const { name, ownerPhone, description, hours, menu, config } = req.body;
  if (!name || !ownerPhone) return reply.status(400).send({ error: 'name e ownerPhone obrigatórios' });

  const business = await prisma.business.upsert({
    where: { id: BUSINESS_ID || 'placeholder' },
    create: { name, ownerPhone, description, hours: hours ?? {}, menu: menu ?? [], config: config ?? {} },
    update: { name, ownerPhone, description, hours, menu, config },
  });

  return business;
});

// Endpoint para ver pedidos
app.get<{ Querystring: { phone?: string } }>('/orders', async (req) => {
  const { phone } = req.query;
  return prisma.order.findMany({
    where: { businessId: BUSINESS_ID, ...(phone ? { phone } : {}) },
    orderBy: { createdAt: 'desc' },
    take: 50,
  });
});

// Endpoint para ver conversas
app.get('/conversations', async () => {
  return prisma.conversation.findMany({
    where: { businessId: BUSINESS_ID },
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
    orderBy: { updatedAt: 'desc' },
  });
});

async function main() {
  if (!BUSINESS_ID) {
    console.warn('⚠️  BUSINESS_ID não configurado. Configure via POST /business e adicione ao .env');
  }

  setMessageHandler(async (phone: string, text: string) => {
    if (!BUSINESS_ID) return 'Sistema em configuração. Tente novamente em breve.';
    return processMessage(phone, text, BUSINESS_ID);
  });

  await app.listen({ port: Number(process.env.PORT ?? 3000), host: '0.0.0.0' });
  console.log(`🚀 Servidor rodando na porta ${process.env.PORT ?? 3000}`);

  console.log('📲 Iniciando WhatsApp...');
  await connect();
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
