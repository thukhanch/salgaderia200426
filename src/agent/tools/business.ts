import { prisma } from '../../db/client';

export async function getBusinessInfo(businessId: string) {
  const business = await prisma.business.findUnique({ where: { id: businessId } });
  if (!business) throw new Error('Negócio não encontrado');
  return {
    name: business.name,
    description: business.description,
    hours: business.hours,
    menu: business.menu,
    config: business.config,
  };
}
