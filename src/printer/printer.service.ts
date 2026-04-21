import { ThermalPrinter, PrinterTypes, CharacterSet } from 'node-thermal-printer';
import { PRINTER_ENABLED, PRINTER_TYPE, PRINTER_ADDRESS, PRINTER_PORT } from '../config';

function buildPrinter(): ThermalPrinter {
  let interfaceAddress: string;

  switch (PRINTER_TYPE) {
    case 'bluetooth':
      // Bluetooth aparece como serial após pareamento: /dev/rfcomm0 (Linux) ou COM3 (Windows)
      interfaceAddress = `serial:${PRINTER_ADDRESS}`;
      break;
    case 'usb':
      interfaceAddress = `usb:${PRINTER_ADDRESS}`;
      break;
    case 'network':
    default:
      interfaceAddress = `tcp://${PRINTER_ADDRESS}:${PRINTER_PORT}`;
  }

  return new ThermalPrinter({
    type: PrinterTypes.EPSON,
    interface: interfaceAddress,
    characterSet: CharacterSet.PC858_EURO,
    removeSpecialCharacters: false,
    lineCharacter: '-',
    width: 48,
  });
}

export async function printOrder(order: {
  id: string;
  items: any[];
  total: number | null;
  scheduledAt: Date | null;
  deliveryType: string | null;
  address: string | null;
  phone: string;
  notes: string | null;
  motoboyName?: string | null;
  paymentStatus?: string | null;
  businessName: string;
}): Promise<void> {
  if (!PRINTER_ENABLED) {
    console.log(`🖨️  [PRINTER DISABLED] Pedido #${order.id.slice(-6).toUpperCase()} seria impresso agora`);
    return;
  }

  const printer = buildPrinter();
  const isConnected = await printer.isPrinterConnected();

  if (!isConnected) {
    console.error('❌ Impressora não encontrada. Verifique a conexão.');
    return;
  }

  const orderId = order.id.slice(-6).toUpperCase();
  const items = order.items as Array<{ name: string; quantity: number; unitPrice: number }>;

  printer.alignCenter();
  printer.setTextSize(1, 1);
  printer.bold(true);
  printer.println(order.businessName.toUpperCase());
  printer.bold(false);
  printer.drawLine();

  printer.alignLeft();
  printer.println(`Pedido: #${orderId}`);
  printer.println(`Cliente: ${order.phone}`);
  printer.println(`Data: ${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`);

  if (order.scheduledAt) {
    printer.println(
      `Entrega: ${new Date(order.scheduledAt).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}`,
    );
  }

  printer.println(`Tipo: ${order.deliveryType === 'delivery' ? '🛵 Entrega' : '🏠 Retirada'}`);

  if (order.address) {
    printer.println(`Endereço: ${order.address}`);
  }

  if (order.motoboyName) {
    printer.println(`Motoboy: ${order.motoboyName}`);
  }

  printer.drawLine();
  printer.bold(true);
  printer.println('ITENS');
  printer.bold(false);

  for (const item of items) {
    const subtotal = (item.quantity * item.unitPrice).toFixed(2);
    printer.tableCustom([
      { text: `${item.quantity}x ${item.name}`, align: 'LEFT', width: 0.7 },
      { text: `R$${subtotal}`, align: 'RIGHT', width: 0.3 },
    ]);
  }

  printer.drawLine();
  printer.bold(true);
  printer.tableCustom([
    { text: 'TOTAL', align: 'LEFT', width: 0.5 },
    { text: `R$${Number(order.total).toFixed(2)}`, align: 'RIGHT', width: 0.5 },
  ]);
  printer.bold(false);

  const pgStatus = order.paymentStatus === 'approved' ? '✓ PAGO' : 'PENDENTE';
  printer.println(`Pagamento: ${pgStatus}`);

  if (order.notes) {
    printer.drawLine();
    printer.println(`Obs: ${order.notes}`);
  }

  printer.drawLine();
  printer.alignCenter();
  printer.println('Obrigado pela preferência!');
  printer.cut();

  await printer.execute();
  console.log(`🖨️  Pedido #${orderId} impresso com sucesso`);
}
