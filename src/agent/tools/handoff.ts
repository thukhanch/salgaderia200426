import { prisma } from '../../db/client';
import { sendMessage } from '../../whatsapp/client';

export async function transferToHuman(phone: string, businessId: string, reason: string) {
  await prisma.conversation.updateMany({
    where: { phone, businessId },
    data: { status: 'handoff' },
  });

  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (business?.ownerPhone) {
    await sendMessage(
      business.ownerPhone,
      `🙋 *Transferência para atendimento humano*\nCliente: ${phone}\nMotivo: ${reason}\n\nResponda diretamente a este número.`,
    );
  }

  return { transferred: true };
}
