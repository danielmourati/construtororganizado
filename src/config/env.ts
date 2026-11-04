import { z } from 'zod';

const envSchema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'test', 'production']).default('production'),
  APP_PUBLIC_URL: z.string().url().default('https://api.sua-logistica.com.br'),

  // Supabase
  SUPABASE_URL: z.string().url(),
  SUPABASE_ANON_KEY: z.string().min(10),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),

  // Evolution API
  EVOLUTION_API_BASE_URL: z.string().url(),
  EVOLUTION_API_KEY: z.string().min(4),
  EVOLUTION_INSTANCE_NAME: z.string().min(1),

  // Chatwoot (Opcional caso o disparo seja feito exclusivamente via Evolution ou ambos)
  CHATWOOT_BASE_URL: z.string().url().optional(),
  CHATWOOT_API_ACCESS_TOKEN: z.string().min(4).optional(),
  CHATWOOT_ACCOUNT_ID: z.coerce.number().int().positive().optional(),
  CHATWOOT_INBOX_ID: z.coerce.number().int().positive().optional(),

  // Mercado Pago
  MP_ACCESS_TOKEN: z.string().min(10),
  MP_WEBHOOK_SECRET: z.string().min(8),
});

export type EnvConfig = z.infer<typeof envSchema>;

let cachedEnv: EnvConfig | null = null;

export function getEnv(): EnvConfig {
  if (cachedEnv) {
    return cachedEnv;
  }

  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    const formatted = parsed.error.issues
      .map((i) => `${i.path.join('.')}: ${i.message}`)
      .join('; ');
    throw new Error(`[Configuração Inválida] Falha na validação das variáveis de ambiente: ${formatted}`);
  }

  cachedEnv = parsed.data;
  return cachedEnv;
}

