import { z } from 'zod';
import { getServiceRoleSupabaseClient, HttpError } from '../lib/supabase.js';
import {
  fetchMercadoPagoPayment,
  verifyMercadoPagoWebhookSignature,
} from '../services/mercadopago.service.js';
import { sendClearedForDeliveryConfirmation } from '../services/messaging.service.js';
import type { ClearedBatchRpcResult } from '../types/logistics.js';

export const mercadoPagoWebhookSchema = z.object({
  id: z.union([z.number(), z.string()]),
  live_mode: z.boolean().optional(),
  type: z.string(),
  action: z.enum(['payment.created', 'payment.updated']).or(z.string()),
  data: z.object({
    id: z.union([z.string(), z.number()]).transform((val) => String(val)),
  }),
});

export interface WebhookProcessResult {
  acknowledged: boolean;
  action: string;
  paymentId: string;
  paymentStatus?: string | undefined;
  batchId?: string | undefined;
  packagesUpdatedToCleared?: number | undefined;
  notificationSent?: boolean | undefined;
}

/**
 * Endpoint Serverless Seguro: POST /api/webhooks/mercadopago
 * Processa eventos `payment.created` e `payment.updated`, valida assinatura HMAC-SHA256,
 * atualiza automaticamente o status dos pacotes para 'Cleared for Delivery' e dispara
 * a confirmação final via Chatwoot / Evolution API.
 */
export async function handleMercadoPagoWebhook(params: {
  xSignatureHeader: string | undefined;
  xRequestIdHeader: string | undefined;
  queryDataId: string | undefined;
  body: unknown;
}): Promise<WebhookProcessResult> {
  const parsed = mercadoPagoWebhookSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new HttpError(400, `Payload de webhook do Mercado Pago malformado: ${parsed.error.message}`);
  }

  const webhook = parsed.data;
  const paymentId = params.queryDataId || webhook.data.id;

  // 1. Verificação Criptográfica de Assinatura (HMAC-SHA256 em tempo constante)
  const isSignatureValid = verifyMercadoPagoWebhookSignature({
    xSignatureHeader: params.xSignatureHeader,
    xRequestIdHeader: params.xRequestIdHeader,
    dataId: paymentId,
  });

  if (!isSignatureValid) {
    throw new HttpError(401, 'Assinatura x-signature do Webhook Mercado Pago inválida.');
  }

  // 2. Filtra apenas eventos de pagamento (`payment.created` e `payment.updated`)
  if (
    webhook.type !== 'payment' &&
    webhook.action !== 'payment.created' &&
    webhook.action !== 'payment.updated'
  ) {
    return {
      acknowledged: true,
      action: webhook.action,
      paymentId,
    };
  }

  // 3. Consulta a fonte de verdade na API do Mercado Pago para confirmar status 'approved'
  const paymentDetails = await fetchMercadoPagoPayment(paymentId);
  const batchId =
    paymentDetails.external_reference ?? paymentDetails.metadata?.batch_id ?? undefined;

  if (paymentDetails.status !== 'approved' || !batchId) {
    return {
      acknowledged: true,
      action: webhook.action,
      paymentId,
      paymentStatus: paymentDetails.status,
      batchId,
      packagesUpdatedToCleared: 0,
      notificationSent: false,
    };
  }

  const adminSupabase = getServiceRoleSupabaseClient();

  // 4. Controle de Idempotência: Registra o evento para evitar disparos duplicados
  const { error: idempotencyError } = await adminSupabase.from('webhook_events').insert({
    provider: 'mercadopago',
    external_event_id: String(webhook.id),
    action: webhook.action,
    resource_id: paymentId,
    payload: webhook,
  });

  // Código PostgreSQL 23505 = unique_violation (evento já foi processado anteriormente)
  if (idempotencyError?.code === '23505') {
    return {
      acknowledged: true,
      action: webhook.action,
      paymentId,
      paymentStatus: 'approved',
      batchId,
      packagesUpdatedToCleared: 0,
      notificationSent: false,
    };
  }

  // 5. Executa a RPC transacional para atualizar os pacotes para 'Cleared for Delivery'
  const { data: rawRpcData, error: rpcError } = await adminSupabase.rpc(
    'mark_batch_cleared_for_delivery',
    {
      p_batch_id: batchId,
      p_mp_payment_id: paymentId,
    }
  );

  const rpcRows = rawRpcData as ClearedBatchRpcResult[] | null;

  if (rpcError || !rpcRows || rpcRows.length === 0) {
    throw new HttpError(
      500,
      `Falha ao atualizar status dos pacotes para 'Cleared for Delivery': ${
        rpcError?.message ?? 'Lote não encontrado'
      }`
    );
  }

  const clearedBatch = rpcRows[0]!;

  // 6. Dispara a mensagem final de confirmação via Chatwoot / Evolution API
  // Apenas se houve pacotes efetivamente transicionados nesta chamada (garantia extra contra duplicidade)
  let notificationSent = false;
  if (clearedBatch.cleared_packages_count > 0) {
    await sendClearedForDeliveryConfirmation({
      batchId: clearedBatch.batch_id,
      receiverName: clearedBatch.receiver_name,
      receiverWhatsapp: clearedBatch.receiver_whatsapp,
      senderName: clearedBatch.sender_name,
      volumeCount: clearedBatch.volume_count,
      totalPrice: Number(clearedBatch.total_price),
      mpPaymentId: paymentId,
      shortCodes: clearedBatch.short_codes,
      chatwootConversationId: clearedBatch.chatwoot_conversation_id,
    });
    notificationSent = true;
  }

  return {
    acknowledged: true,
    action: webhook.action,
    paymentId,
    paymentStatus: paymentDetails.status,
    batchId: clearedBatch.batch_id,
    packagesUpdatedToCleared: Number(clearedBatch.cleared_packages_count),
    notificationSent,
  };
}

