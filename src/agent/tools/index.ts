import type { ChatCompletionTool } from 'openai/resources';

export const tools: ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'get_business_info',
      description: 'Retorna informações do negócio: nome, descrição, cardápio, horários e configurações.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_order',
      description: 'Cria e confirma um pedido. Use somente quando o cliente confirmar explicitamente o pedido.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            description: 'Lista de itens do pedido',
            items: {
              type: 'object',
              properties: {
                name: { type: 'string', description: 'Nome do item' },
                quantity: { type: 'number', description: 'Quantidade' },
                unitPrice: { type: 'number', description: 'Preço unitário' },
              },
              required: ['name', 'quantity', 'unitPrice'],
            },
          },
          scheduledAt: { type: 'string', description: 'Data/hora do agendamento em ISO 8601' },
          deliveryType: { type: 'string', enum: ['pickup', 'delivery'] },
          address: { type: 'string', description: 'Endereço de entrega (se delivery)' },
          notes: { type: 'string', description: 'Observações adicionais' },
        },
        required: ['items'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_orders',
      description: 'Retorna os últimos pedidos do cliente.',
      parameters: { type: 'object', properties: {}, required: [] },
    },
  },
  {
    type: 'function',
    function: {
      name: 'cancel_order',
      description: 'Cancela um pedido pelo ID.',
      parameters: {
        type: 'object',
        properties: {
          orderId: { type: 'string', description: 'ID do pedido (6 caracteres)' },
        },
        required: ['orderId'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'transfer_to_human',
      description: 'Transfere o atendimento para um humano. Use quando o cliente pedir explicitamente ou quando não conseguir resolver a situação.',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: 'Motivo da transferência' },
        },
        required: ['reason'],
      },
    },
  },
];
