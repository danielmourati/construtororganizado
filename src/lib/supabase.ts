import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { getEnv } from '../config/env.js';
import type { AuthTenantContext } from '../types/logistics.js';

let serviceRoleClient: SupabaseClient | null = null;

/**
 * Cria um cliente Supabase escopado com o JWT do usuário autenticado.
 * Garante que todas as queries respeitem as políticas de Row Level Security (RLS)
 * baseadas em `auth.uid()` (user_id) e `location_id`.
 */
export function createRlsSupabaseClient(accessToken: string): SupabaseClient {
  const env = getEnv();

  return createClient(env.SUPABASE_URL, env.SUPABASE_ANON_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
    global: {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    },
  });
}

/**
 * Cliente Administrativo (Service Role) para uso exclusivo em processos confiáveis
 * de backend (como o listener de Webhook assinado do Mercado Pago).
 */
export function getServiceRoleSupabaseClient(): SupabaseClient {
  if (serviceRoleClient) {
    return serviceRoleClient;
  }

  const env = getEnv();
  serviceRoleClient = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });

  return serviceRoleClient;
}

/**
 * Extrai e valida o contexto Multi-Tenant (`userId` e `locationId`) a partir dos headers HTTP.
 */
export async function resolveTenantContext(
  authorizationHeader: string | undefined,
  locationHeader: string | undefined
): Promise<{ client: SupabaseClient; context: AuthTenantContext }> {
  if (!authorizationHeader?.startsWith('Bearer ')) {
    throw new HttpError(401, 'Token Bearer de autenticação ausente ou malformado.');
  }

  const accessToken = authorizationHeader.slice('Bearer '.length).trim();
  const client = createRlsSupabaseClient(accessToken);

  const { data: userData, error: authError } = await client.auth.getUser(accessToken);
  if (authError || !userData.user) {
    throw new HttpError(401, 'Sessão inválida ou expirada no Supabase Auth.');
  }

  const jwtLocationId =
    typeof userData.user.app_metadata?.['location_id'] === 'string'
      ? userData.user.app_metadata['location_id']
      : undefined;

  const locationId = (locationHeader?.trim() || jwtLocationId)?.trim();
  if (!locationId) {
    throw new HttpError(
      400,
      'Unidade logística (location_id) não informada no header x-location-id nem presente em app_metadata.'
    );
  }

  return {
    client,
    context: {
      userId: userData.user.id,
      locationId,
      accessToken,
    },
  };
}

export class HttpError extends Error {
  public readonly statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = 'HttpError';
    this.statusCode = statusCode;
  }
}

