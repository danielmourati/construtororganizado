import { z } from 'zod';
import { HttpError, resolveTenantContext } from '../lib/supabase.js';
import { createBatchCheckoutLink } from '../services/mercadopago.service.js';
import { sendBatchPricingWhatsApp } from '../services/messaging.service.js';
import type {
  BarcodeScanResolution,
  PackageBatchRecord,
  PackageRecord,
} from '../types/logistics.js';
import { generatePackageIdentifiers } from '../utils/shortCode.js';

/**
 * Schemas de validação estrita (Zod) para os endpoints de pacotes e lotes
 */
export const registerPackageItemSchema = z.object({
  weightKg: z.number().positive().max(5000).optional(),
  description: z.string().trim().max(500).optional(),
  shortCodeLength: z.union([z.literal(6), z.literal(7), z.literal(8)]).default(7),
  metadata: z.record(z.unknown()).default({}),
});

export const registerPackagesRequestSchema = z.object({
  senderName: z.string().trim().min(2).max(180),
  senderDocument: z.string().trim().max(30).optional(),
  receiverName: z.string().trim().min(2).max(180),
  receiverWhatsapp: z.string().trim().min(10).max(30),
  receiverEmail: z.string().email().optional(),
  chatwootConversationId: z.number().int().positive().optional(),
  createBatch: z.boolean().default(true),
  batchId: z.string().uuid().optional(),
  packages: z.array(registerPackageItemSchema).min(1).max(100),
});

export const priceBatchRequestSchema = z.object({
  totalPrice: z.number().positive(),
});

export const scanShortCodeSchema = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{6,8}$/, 'Código de barras curto inválido (deve conter de 6 a 8 caracteres alfanuméricos).');

export type RegisterPackagesInput = z.infer<typeof registerPackagesRequestSchema>;
export type PriceBatchInput = z.infer<typeof priceBatchRequestSchema>;

/**
 * Endpoint Serverless: POST /api/packages
 * Registra um ou múltiplos pacotes vinculados ao `location_id` e `user_id` (via RLS),
 * gerando automaticamente um UUID relacional e um `short_code` alfanumérico de 6-8 caracteres.
 */
export async function handleRegisterPackages(params: {
  authorizationHeader: string | undefined;
  locationHeader: string | undefined;
  body: unknown;
}): Promise<{
  batch: PackageBatchRecord | null;
  packages: PackageRecord[];
}> {
  const { client, context } = await resolveTenantContext(
    params.authorizationHeader,
    params.locationHeader
  );

  const parsed = registerPackagesRequestSchema.safeParse(params.body);
  if (!parsed.success) {
    throw new HttpError(400, `Payload inválido: ${parsed.error.message}`);
  }

  const payload = parsed.data;
  let activeBatchId = payload.batchId ?? null;
  let createdBatch: PackageBatchRecord | null = null;

  // Cria o lote (batch) caso solicitado e nenhum batchId pré-existente tenha sido passado
  if (payload.createBatch && !activeBatchId) {
    const { data: batchData, error: batchError } = await client
      .from('package_batches')
      .insert({
        location_id: context.locationId,
        user_id: context.userId,
        sender_name: payload.senderName,
        sender_document: payload.senderDocument ?? null,
        receiver_name: payload.receiverName,
        receiver_whatsapp: payload.receiverWhatsapp,
        receiver_email: payload.receiverEmail ?? null,
        chatwoot_conversation_id: payload.chatwootConversationId ?? null,
        volume_count: payload.packages.length,
        payment_status: 'pending_pricing',
      })
      .select('*')
      .single<PackageBatchRecord>();

    if (batchError || !batchData) {
      throw new HttpError(
        500,
        `Erro ao criar lote de pacotes sob RLS: ${batchError?.message ?? 'Erro desconhecido'}`
      );
    }

    createdBatch = batchData;
    activeBatchId = batchData.id;
  }

  // Gera UUID + short_code alfanumérico (6-8 chars) para cada volume
  const usedCodesInBatch = new Set<string>();
  const rowsToInsert = payload.packages.map((pkg) => {
    let identifiers = generatePackageIdentifiers(pkg.shortCodeLength);
    while (usedCodesInBatch.has(identifiers.shortCode)) {
      identifiers = generatePackageIdentifiers(pkg.shortCodeLength);
    }
    usedCodesInBatch.add(identifiers.shortCode);

    return {
      id: identifiers.id,
      short_code: identifiers.shortCode,
      batch_id: activeBatchId,
      location_id: context.locationId,
      user_id: context.userId,
      sender_name: payload.senderName,
      receiver_name: payload.receiverName,
      receiver_whatsapp: payload.receiverWhatsapp,
      weight_kg: pkg.weightKg ?? null,
      description: pkg.description ?? null,
      status: 'Registered' as const,
      metadata: pkg.metadata,
    };
  });

  const { data: insertedPackages, error: insertError } = await client
    .from('packages')
    .insert(rowsToInsert)
    .select('*')
    .returns<PackageRecord[]>();

  if (insertError || !insertedPackages) {
    throw new HttpError(
      500,
      `Falha ao registrar pacotes (verifique permissões RLS para location_id): ${
        insertError?.message ?? 'Erro desconhecido'
      }`
    );
  }

  return {
    batch: createdBatch,
    packages: insertedPackages,
  };
}

/**
 * Endpoint Serverless de Baixa Latência: GET /api/packages/scan/:shortCode
 * Otimizado para coletores de código de barras (Index-Only Scan sobre `idx_packages_scan_resolution`).
 */
export async function handleBarcodeScanResolution(params: {
  authorizationHeader: string | undefined;
  locationHeader: string | undefined;
  shortCode: string;
}): Promise<BarcodeScanResolution> {
  const startTime = performance.now();

  const validCode = scanShortCodeSchema.safeParse(params.shortCode);
  if (!validCode.success) {
    throw new HttpError(400, validCode.error.issues[0]?.message ?? 'short_code inválido.');
  }

  const { client, context } = await resolveTenantContext(
    params.authorizationHeader,
    params.locationHeader
  );

  // Projeção enxuta que casa exatamente com o INCLUDE do índice `idx_packages_scan_resolution`
  const { data: pkg, error } = await client
    .from('packages')
    .select(
      'id, short_code, batch_id, location_id, status, sender_name, receiver_name, receiver_whatsapp, weight_kg, cleared_at'
    )
    .eq('short_code', validCode.data)
    .eq('location_id', context.locationId)
    .maybeSingle<{
      id: string;
      short_code: string;
      batch_id: string | null;
      location_id: string;
      status: PackageRecord['status'];
      sender_name: string;
      receiver_name: string;
      receiver_whatsapp: string;
      weight_kg: number | null;
      cleared_at: string | null;
    }>();

  if (error) {
    throw new HttpError(500, `Erro ao consultar código de barras: ${error.message}`);
  }

  if (!pkg) {
    throw new HttpError(
      404,
      `Pacote com código de barras '${validCode.data}' não encontrado nesta unidade logística.`
    );
  }

  const elapsedMs = Number((performance.now() - startTime).toFixed(2));

  return {
    id: pkg.id,
    short_code: pkg.short_code,
    batch_id: pkg.batch_id,
    location_id: pkg.location_id,
    status: pkg.status,
    is_cleared_for_delivery: pkg.status === 'Cleared for Delivery',
    sender_name: pkg.sender_name,
    receiver_name: pkg.receiver_name,
    receiver_whatsapp: pkg.receiver_whatsapp,
    weight_kg: pkg.weight_kg,
    cleared_at: pkg.cleared_at,
    resolved_in_ms: elapsedMs,
  };
}

/**
 * Endpoint Serverless: POST /api/batches/:batchId/price
 * Precifica um lote de pacotes, gera dinamicamente o link de checkout do Mercado Pago
 * e dispara automaticamente a notificação de WhatsApp via Evolution API para o destinatário.
 */
export async function handlePriceBatchAndDispatchWhatsApp(params: {
  authorizationHeader: string | undefined;
  locationHeader: string | undefined;
  batchId: string;
  body: unknown;
}): Promise<{
  batchId: string;
  volumeCount: number;
  totalPrice: number;
  checkoutUrl: string;
  preferenceId: string;
  shortCodes: string[];
  whatsappDispatched: boolean;
}> {
  const { client, context } = await resolveTenantContext(
    params.authorizationHeader,
    params.locationHeader
  );

  const parsedBody = priceBatchRequestSchema.safeParse(params.body);
  if (!parsedBody.success) {
    throw new HttpError(400, `Valor de precificação inválido: ${parsedBody.error.message}`);
  }

  const { totalPrice } = parsedBody.data;

  // 1. Busca o lote garantindo isolamento RLS (location_id e user_id)
  const { data: batch, error: batchErr } = await client
    .from('package_batches')
    .select('*')
    .eq('id', params.batchId)
    .eq('location_id', context.locationId)
    .single<PackageBatchRecord>();

  if (batchErr || !batch) {
    throw new HttpError(404, 'Lote de pacotes não encontrado ou sem permissão de acesso.');
  }

  if (batch.payment_status === 'paid') {
    throw new HttpError(409, 'Este lote já consta como pago e liberado para entrega.');
  }

  // 2. Busca os pacotes vinculados ao lote para consolidar a contagem de volumes e short_codes
  const { data: batchPackages, error: pkgsErr } = await client
    .from('packages')
    .select('id, short_code')
    .eq('batch_id', batch.id)
    .eq('location_id', context.locationId)
    .returns<Array<{ id: string; short_code: string }>>();

  if (pkgsErr || !batchPackages || batchPackages.length === 0) {
    throw new HttpError(400, 'O lote não possui pacotes registrados para precificação.');
  }

  const volumeCount = batchPackages.length;
  const shortCodes = batchPackages.map((p) => p.short_code);

  // 3. Gera dinamicamente o link de Checkout no Mercado Pago
  const checkout = await createBatchCheckoutLink({
    batchId: batch.id,
    locationId: context.locationId,
    senderName: batch.sender_name,
    receiverName: batch.receiver_name,
    receiverEmail: batch.receiver_email ?? undefined,
    volumeCount,
    totalPrice,
    shortCodes,
  });

  // 4. Atualiza o lote e os pacotes para 'Awaiting Payment'
  const { error: updateBatchErr } = await client
    .from('package_batches')
    .update({
      volume_count: volumeCount,
      total_price: totalPrice,
      payment_status: 'awaiting_payment',
      mp_preference_id: checkout.preferenceId,
      mp_checkout_url: checkout.checkoutUrl,
      updated_at: new Date().toISOString(),
    })
    .eq('id', batch.id)
    .eq('location_id', context.locationId);

  if (updateBatchErr) {
    throw new HttpError(500, `Falha ao atualizar lote precificado: ${updateBatchErr.message}`);
  }

  const { error: updatePkgsErr } = await client
    .from('packages')
    .update({
      status: 'Awaiting Payment',
      updated_at: new Date().toISOString(),
    })
    .eq('batch_id', batch.id)
    .eq('location_id', context.locationId);

  if (updatePkgsErr) {
    throw new HttpError(500, `Falha ao atualizar status dos pacotes: ${updatePkgsErr.message}`);
  }

  // 5. Orquestra o disparo automático do WhatsApp via Evolution API para o destinatário
  await sendBatchPricingWhatsApp({
    receiverName: batch.receiver_name,
    receiverWhatsapp: batch.receiver_whatsapp,
    senderName: batch.sender_name,
    volumeCount,
    totalPrice,
    checkoutUrl: checkout.checkoutUrl,
    shortCodes,
  });

  return {
    batchId: batch.id,
    volumeCount,
    totalPrice,
    checkoutUrl: checkout.checkoutUrl,
    preferenceId: checkout.preferenceId,
    shortCodes,
    whatsappDispatched: true,
  };
}

