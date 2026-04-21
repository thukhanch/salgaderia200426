import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources';
import { prisma } from '../db/client';
import { tools } from './tools/index';
import { getBusinessInfo } from './tools/business';
import { createOrder, getOrders, cancelOrder } from './tools/orders';
import { transferToHuman } from './tools/handoff';

const rawBaseURL = process.env.OPENAI_BASE_URL ?? 'http://localhost:20128';
const baseURL = rawBaseURL.endsWith('/v1') ? rawBaseURL : `${rawBaseURL.replace(/\/$/, '')}/v1`;

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY ?? 'no-key',
  baseURL,
});

const MODEL = process.env.MODEL_NAME ?? 'gpt-4.5';
const MAX_HISTORY = 30;

function buildSystemPrompt(business: Awaited<ReturnType<typeof getBusinessInfo>>) {
  const menu = (business.menu as any[])
    .map(item => `• ${item.name}: R$ ${Number(item.price).toFixed(2)}${item.unit ? `/${item.unit}` : ''}${item.description ? ` — ${item.description}` : ''}`)
    .join('\n');

  const hours = business.hours as any;

  return `Você é o assistente virtual de "${business.name}".
${business.description ? business.description + '\n' : ''}
Seu papel é atender clientes via WhatsApp de forma natural, amigável e eficiente.

## Cardápio
${menu}

## Horário de funcionamento
${hours.open} às ${hours.close}

## Regras importantes
- Converse naturalmente. Não use menus numerados nem fluxos rígidos.
- Colete as informações necessárias para o pedido ao longo da conversa (itens, quantidade, data, tipo de entrega).
- Só confirme o pedido quando o cliente disser que quer confirmar/fechar.
- Antes de criar o pedido, sempre mostre um resumo e peça confirmação.
- Se não souber responder algo, seja honesto e ofereça transferir para um humano.
- Responda sempre em português do Brasil.
- Seja conciso. Não escreva textos longos desnecessariamente.`;
}

async function getOrCreateConversation(phone: string, businessId: string) {
  let convo = await prisma.conversation.findUnique({
    where: { phone_businessId: { phone, businessId } },
    include: { messages: { orderBy: { createdAt: 'asc' }, take: MAX_HISTORY } },
  });

  if (!convo) {
    convo = await prisma.conversation.create({
      data: { phone, businessId },
      include: { messages: { orderBy: { createdAt: 'asc' }, take: MAX_HISTORY } },
    });
  }

  return convo;
}

async function saveMessage(
  conversationId: string,
  role: string,
  content: string,
  extra?: { toolCallId?: string; toolName?: string; toolArgs?: any },
) {
  await prisma.message.create({
    data: { conversationId, role, content, ...extra },
  });
}

export async function processMessage(phone: string, text: string, businessId: string): Promise<string> {
  const business = await getBusinessInfo(businessId);
  const convo = await getOrCreateConversation(phone, businessId);

  if (convo.status === 'handoff') {
    return 'Você está sendo atendido por nossa equipe. Em breve alguém responderá.';
  }

  await saveMessage(convo.id, 'user', text);

  const history: ChatCompletionMessageParam[] = convo.messages.map(m => {
    if (m.role === 'tool') {
      return { role: 'tool', tool_call_id: m.toolCallId!, content: m.content } as ChatCompletionMessageParam;
    }
    return { role: m.role as 'user' | 'assistant', content: m.content };
  });

  history.push({ role: 'user', content: text });

  const messages: ChatCompletionMessageParam[] = [
    { role: 'system', content: buildSystemPrompt(business) },
    ...history,
  ];

  let finalContent = '';

  for (let i = 0; i < 8; i++) {
    const response = await openai.chat.completions.create({
      model: MODEL,
      messages,
      tools,
      tool_choice: 'auto',
    });

    const choice = response.choices[0];
    const msg = choice.message;

    messages.push(msg as ChatCompletionMessageParam);

    if (choice.finish_reason === 'stop' || !msg.tool_calls?.length) {
      finalContent = msg.content ?? '';
      await saveMessage(convo.id, 'assistant', finalContent);
      break;
    }

    const assistantContent = JSON.stringify(msg.tool_calls);
    await saveMessage(convo.id, 'assistant', assistantContent);

    for (const call of msg.tool_calls) {
      const args = JSON.parse(call.function.arguments || '{}');
      let result: any;

      try {
        switch (call.function.name) {
          case 'get_business_info':
            result = business;
            break;
          case 'create_order':
            result = await createOrder({ businessId, phone, ...args });
            break;
          case 'get_orders':
            result = await getOrders(phone, businessId);
            break;
          case 'cancel_order':
            result = await cancelOrder(args.orderId);
            break;
          case 'transfer_to_human':
            result = await transferToHuman(phone, businessId, args.reason);
            break;
          default:
            result = { error: 'Ferramenta desconhecida' };
        }
      } catch (err: any) {
        result = { error: err.message };
      }

      const resultStr = JSON.stringify(result);
      await saveMessage(convo.id, 'tool', resultStr, {
        toolCallId: call.id,
        toolName: call.function.name,
        toolArgs: args,
      });

      messages.push({ role: 'tool', tool_call_id: call.id, content: resultStr });
    }
  }

  return finalContent || 'Desculpe, não consegui processar sua mensagem. Tente novamente.';
}
