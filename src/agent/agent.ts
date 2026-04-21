import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources';
import { prisma } from '../db/client';
import { tools } from './tools/index';
import { getBusinessInfo } from './tools/business';
import { createOrder, getOrders, cancelOrder } from './tools/orders';
import { transferToHuman } from './tools/handoff';
import { buildSystemPrompt } from './script';
import { OPENAI_API_KEY, OPENAI_BASE_URL, MODEL_NAME } from '../config';

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
  baseURL: OPENAI_BASE_URL,
});

const MODEL = MODEL_NAME;
const MAX_HISTORY = 30;

const INJECTION_PATTERNS = [
  /ignore\s+(all\s+)?(previous|prior|above|suas?)\s*(instructions?|instru[çc][õo]es?|regras?)/i,
  /you\s+are\s+now/i,
  /novo\s+personagem/i,
  /modo\s+(desenvolvedor|developer|admin|god|irrestrito|sem\s+limites?)/i,
  /act\s+as\s+(if\s+)?you\s+(are|were|have\s+no)/i,
  /pretend\s+(you|to\s+be)/i,
  /jailbreak/i,
  /dan\s+mode/i,
  /unlock\s+(your|hidden|secret|true)/i,
  /sem\s+(restri[çc][õo]es?|limites?|regras?)/i,
  /revele?\s+(seu\s+)?(prompt|instru[çc][õo]es?|sistema)/i,
  /mostre?\s+(seu\s+)?(system\s+prompt|instru[çc][õo]es?\s+internas?)/i,
  /what\s+(is\s+your|are\s+your)\s+(system\s+prompt|instructions)/i,
];

function detectInjection(text: string): boolean {
  return INJECTION_PATTERNS.some(p => p.test(text));
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
    return 'Você está sendo atendido por nossa equipe. Em breve alguém responderá. 🙋';
  }

  // Detecção de prompt injection — loga mas não bloqueia (o prompt já instrui o modelo)
  if (detectInjection(text)) {
    console.warn(`⚠️  Possível prompt injection detectado de ${phone}: "${text.slice(0, 100)}"`);
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

  return finalContent || 'Desculpe, não consegui processar sua mensagem. Tente novamente em instantes.';
}
