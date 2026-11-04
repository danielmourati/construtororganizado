import { createHmac, timingSafeEqual } from 'node:crypto';
import { getEnv } from '../config/env.js';
import type {
  CheckoutPreferenceResult,
  CreateCheckoutPreferenceInput,
  MercadoPagoPaymentDetails,
} from '../types/logistics.js';

const MP_API_BASE = 'https://api.mercadopago.com';

/**
 * Gera dinamicamente uma preferência de pagamento (Checkout Pro) no Mercado Pago
 * para um lote de pacotes precificado.
 */
export async function createBatchCheckoutLink(
  input: CreateCheckoutPreferenceInput
): Promise<CheckoutPreferenceResult> {
  const env = getEnv();

  const preferencePayload = {
    external_reference: input.batchId,
    statement_descriptor: 'LOGISTICA SAAS',
    notification_url: `${env.APP_PUBLIC_URL}/api/webhooks/mercadopago`,
    items: [
      {
        id: input.batchId,
        title: `Despacho Logístico - ${input.volumeCount} volume(s) | Remetente: ${input.senderName}`,
        description: `Códigos de barras: ${input.shortCodes.join(', ')}`,
        quantity: 1,
        currency_id: 'BRL',
        unit_price: Number(input.totalPrice.toFixed(2)),
      },
    ],
    payer: {
      name: input.receiverName,
      ...(input.receiverEmail ? { email: input.receiverEmail } : {}),
    },
    metadata: {
      batch_id: input.batchId,
      location_id: input.locationId,
      volume_count: input.volumeCount,
      short_codes: input.shortCodes,
    },
  };

  const response = await fetch(`${MP_API_BASE}/checkout/preferences`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': `batch-pref-${input.batchId}-${input.totalPrice}`,
    },
    body: JSON.stringify(preferencePayload),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `[MercadoPago] Erro ao gerar link de checkout (${response.status}): ${errorBody}`
    );
  }

  const data = (await response.json()) as {
    id: string;
    init_point: string;
    sandbox_init_point?: string;
  };

  return {
    preferenceId: data.id,
    checkoutUrl: data.init_point,
    sandboxCheckoutUrl: data.sandbox_init_point,
  };
}

/**
 * Consulta os detalhes reais de um pagamento na API oficial do Mercado Pago
 * para garantir que o evento recebido no webhook está realmente aprovado.
 */
export async function fetchMercadoPagoPayment(
  paymentId: string
): Promise<MercadoPagoPaymentDetails> {
  const env = getEnv();

  const response = await fetch(`${MP_API_BASE}/v1/payments/${encodeURIComponent(paymentId)}`, {
    method: 'GET',
    headers: {
      Authorization: `Bearer ${env.MP_ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `[MercadoPago] Falha ao consultar pagamento ${paymentId} (${response.status}): ${errorBody}`
    );
  }

  return (await response.json()) as MercadoPagoPaymentDetails;
}

/**
 * Valida a assinatura HMAC-SHA256 (`x-signature`) enviada pelo Mercado Pago nos Webhooks.
 * Formato oficial do manifesto: `id:[data.id_url];request-id:[x-request-id_header];ts:[ts_header];`
 */
export function verifyMercadoPagoWebhookSignature(params: {
  xSignatureHeader: string | undefined;
  xRequestIdHeader: string | undefined;
  dataId: string;
}): boolean {
  const { xSignatureHeader, xRequestIdHeader, dataId } = params;
  if (!xSignatureHeader || !xRequestIdHeader || !dataId) {
    return false;
  }

  const env = getEnv();

  let ts = '';
  let v1 = '';

  for (const part of xSignatureHeader.split(',')) {
    const [key, value] = part.split('=').map((s) => s.trim());
    if (key === 'ts' && value) ts = value;
    if (key === 'v1' && value) v1 = value;
  }

  if (!ts || !v1) {
    return false;
  }

  const manifest = `id:${dataId.toLowerCase()};request-id:${xRequestIdHeader};ts:${ts};`;
  const computedHex = createHmac('sha256', env.MP_WEBHOOK_SECRET)
    .update(manifest)
    .digest('hex');

  const expectedBuffer = Buffer.from(computedHex, 'utf8');
  const receivedBuffer = Buffer.from(v1, 'utf8');

  if (expectedBuffer.length !== receivedBuffer.length) {
    return false;
  }

  return timingSafeEqual(expectedBuffer, receivedBuffer);
}

