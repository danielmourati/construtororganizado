/**
 * Tipagens estritas do domínio de Logística SaaS, Banco de Dados (Supabase),
 * Evolution API, Chatwoot e Mercado Pago.
 */

export type PackageStatus =
  | 'Registered'
  | 'Priced'
  | 'Awaiting Payment'
  | 'Cleared for Delivery'
  | 'Out for Delivery'
  | 'Delivered'
  | 'Cancelled';

export type BatchPaymentStatus =
  | 'pending_pricing'
  | 'awaiting_payment'
  | 'paid'
  | 'cancelled';

export interface AuthTenantContext {
  readonly userId: string;
  readonly locationId: string;
  readonly accessToken: string;
}

export interface PackageRecord {
  id: string;
  short_code: string;
  batch_id: string | null;
  location_id: string;
  user_id: string;
  sender_name: string;
  receiver_name: string;
  receiver_whatsapp: string;
  weight_kg: number | null;
  description: string | null;
  status: PackageStatus;
  last_scanned_at: string | null;
  cleared_at: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

export interface PackageBatchRecord {
  id: string;
  location_id: string;
  user_id: string;
  sender_name: string;
  sender_document: string | null;
  receiver_name: string;
  receiver_whatsapp: string;
  receiver_email: string | null;
  chatwoot_conversation_id: number | null;
  volume_count: number;
  total_price: number;
  currency: string;
  payment_status: BatchPaymentStatus;
  mp_preference_id: string | null;
  mp_checkout_url: string | null;
  mp_payment_id: string | null;
  paid_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Payload otimizado retornado na leitura de código de barras (baixa latência)
 */
export interface BarcodeScanResolution {
  id: string;
  short_code: string;
  batch_id: string | null;
  location_id: string;
  status: PackageStatus;
  is_cleared_for_delivery: boolean;
  sender_name: string;
  receiver_name: string;
  receiver_whatsapp: string;
  weight_kg: number | null;
  cleared_at: string | null;
  resolved_in_ms: number;
}

/**
 * Contratos de Integração - Mercado Pago
 */
export interface CreateCheckoutPreferenceInput {
  batchId: string;
  locationId: string;
  senderName: string;
  receiverName: string;
  receiverEmail?: string | undefined;
  volumeCount: number;
  totalPrice: number;
  shortCodes: readonly string[];
}

export interface CheckoutPreferenceResult {
  preferenceId: string;
  checkoutUrl: string;
  sandboxCheckoutUrl?: string | undefined;
}

export type MercadoPagoWebhookAction = 'payment.created' | 'payment.updated';

export interface MercadoPagoWebhookPayload {
  id: number | string;
  live_mode: boolean;
  type: 'payment' | string;
  date_created: string;
  user_id: number | string;
  api_version: string;
  action: MercadoPagoWebhookAction | string;
  data: {
    id: string;
  };
}

export interface MercadoPagoPaymentDetails {
  id: number;
  status: 'approved' | 'pending' | 'authorized' | 'in_process' | 'in_mediation' | 'rejected' | 'cancelled' | 'refunded' | 'charged_back';
  status_detail: string;
  external_reference: string | null;
  transaction_amount: number;
  currency_id: string;
  date_approved: string | null;
  metadata?: {
    batch_id?: string;
    location_id?: string;
  };
}

/**
 * Contratos de Integração - Evolution API & Chatwoot
 */
export interface PricingWhatsAppNotificationInput {
  receiverName: string;
  receiverWhatsapp: string;
  senderName: string;
  volumeCount: number;
  totalPrice: number;
  checkoutUrl: string;
  shortCodes: readonly string[];
}

export interface ClearedDeliveryNotificationInput {
  batchId: string;
  receiverName: string;
  receiverWhatsapp: string;
  senderName: string;
  volumeCount: number;
  totalPrice: number;
  mpPaymentId: string;
  shortCodes: readonly string[];
  chatwootConversationId?: number | null | undefined;
}

export interface ClearedBatchRpcResult {
  batch_id: string;
  location_id: string;
  sender_name: string;
  receiver_name: string;
  receiver_whatsapp: string;
  chatwoot_conversation_id: number | null;
  volume_count: number;
  total_price: number;
  cleared_packages_count: number;
  short_codes: string[];
}

