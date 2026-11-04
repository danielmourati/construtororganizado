import { getEnv } from '../config/env.js';
import type {
  ClearedDeliveryNotificationInput,
  PricingWhatsAppNotificationInput,
} from '../types/logistics.js';

/**
 * Normaliza números de telefone para o padrão E.164 exigido pela Evolution API (apenas dígitos, DDI 55 padrão se omitido).
 */
export function normalizeWhatsAppNumber(rawPhone: string): string {
  const digits = rawPhone.replace(/\D/g, '');
  if (digits.length === 10 || digits.length === 11) {
    return `55${digits}`;
  }
  return digits;
}

function formatBRL(amount: number): string {
  return new Intl.NumberFormat('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  }).format(amount);
}

/**
 * Envia mensagem de WhatsApp via Evolution API v2 (`/message/sendText/{instance}`).
 */
async function dispatchEvolutionTextMessage(number: string, text: string): Promise<void> {
  const env = getEnv();
  const normalizedNumber = normalizeWhatsAppNumber(number);
  const endpoint = `${env.EVOLUTION_API_BASE_URL.replace(/\/$/, '')}/message/sendText/${encodeURIComponent(
    env.EVOLUTION_INSTANCE_NAME
  )}`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      apikey: env.EVOLUTION_API_KEY,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      number: normalizedNumber,
      text,
      delay: 800,
      linkPreview: true,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(
      `[Evolution API] Falha ao enviar WhatsApp para ${normalizedNumber} (${response.status}): ${errorText}`
    );
  }
}

/**
 * Envia confirmação também na conversa do Chatwoot quando configurada,
 * mantendo a operação omnichannel sincronizada com o disparo da Evolution API.
 */
async function dispatchChatwootMessage(
  conversationId: number,
  content: string
): Promise<void> {
  const env = getEnv();
  if (!env.CHATWOOT_BASE_URL || !env.CHATWOOT_API_ACCESS_TOKEN || !env.CHATWOOT_ACCOUNT_ID) {
    return;
  }

  const endpoint = `${env.CHATWOOT_BASE_URL.replace(/\/$/, '')}/api/v1/accounts/${
    env.CHATWOOT_ACCOUNT_ID
  }/conversations/${conversationId}/messages`;

  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      api_access_token: env.CHATWOOT_API_ACCESS_TOKEN,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      content,
      message_type: 'outgoing',
      private: false,
    }),
  });

  if (!response.ok) {
    const errText = await response.text();
    throw new Error(
      `[Chatwoot API] Falha ao postar mensagem na conversa ${conversationId} (${response.status}): ${errText}`
    );
  }
}

/**
 * 1. Fluxo de Orquestração de Cobrança (Evolution API):
 * Disparado automaticamente assim que um lote de pacotes é precificado.
 * Contém detalhes do remetente, quantidade de volumes, valor total e link dinâmico do Mercado Pago.
 */
export async function sendBatchPricingWhatsApp(
  input: PricingWhatsAppNotificationInput
): Promise<void> {
  const formattedPrice = formatBRL(input.totalPrice);
  const codesList = input.shortCodes.map((code) => `• *${code}*`).join('\n');

  const message = [
    `Olá, *${input.receiverName}*! 📦`,
    ``,
    `Seu lote de encomendas foi conferido e precificado em nossa unidade logística.`,
    ``,
    `📋 *Resumo da Remessa:*`,
    `• *Remetente:* ${input.senderName}`,
    `• *Quantidade de Volumes:* ${input.volumeCount}`,
    `• *Valor Total:* ${formattedPrice}`,
    ``,
    `🏷️ *Códigos de Rastreio/Etiqueta:*`,
    codesList,
    ``,
    `💳 *Para liberar imediatamente seus pacotes para entrega, realize o pagamento pelo link seguro do Mercado Pago abaixo:*`,
    `${input.checkoutUrl}`,
    ``,
    `_Assim que o pagamento for confirmado, você receberá a confirmação automática de liberação._`,
  ].join('\n');

  await dispatchEvolutionTextMessage(input.receiverWhatsapp, message);
}

/**
 * 2. Fluxo de Confirmação de Liberação ('Cleared for Delivery') via Evolution API & Chatwoot:
 * Disparado automaticamente pelo Webhook do Mercado Pago após confirmação de pagamento aprovado.
 */
export async function sendClearedForDeliveryConfirmation(
  input: ClearedDeliveryNotificationInput
): Promise<void> {
  const formattedPrice = formatBRL(input.totalPrice);
  const codesInline = input.shortCodes.join(', ');

  const confirmationMessage = [
    `✅ *PAGAMENTO CONFIRMADO - LIBERADO PARA ENTREGA!*`,
    ``,
    `Olá, *${input.receiverName}*! Recebemos a confirmação do seu pagamento via Mercado Pago (Comprovante #${input.mpPaymentId}).`,
    ``,
    `🚚 *Status Atual:* *Cleared for Delivery (Liberado para Entrega)*`,
    `• *Remetente:* ${input.senderName}`,
    `• *Volumes Liberados:* ${input.volumeCount} (${codesInline})`,
    `• *Valor Pago:* ${formattedPrice}`,
    ``,
    `Seus pacotes já estão autorizados para expedição/retirada!`,
  ].join('\n');

  const tasks: Promise<void>[] = [
    dispatchEvolutionTextMessage(input.receiverWhatsapp, confirmationMessage),
  ];

  if (input.chatwootConversationId) {
    tasks.push(dispatchChatwootMessage(input.chatwootConversationId, confirmationMessage));
  }

  await Promise.allSettled(tasks).then((results) => {
    const errors = results.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected'
    );
    if (errors.length === results.length) {
      throw new Error(
        `Falha ao disparar confirmação final na Evolution/Chatwoot: ${errors
          .map((e) => String(e.reason))
          .join(' | ')}`
      );
    }
  });
}

