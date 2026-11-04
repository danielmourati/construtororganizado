# SaaS Logística Backend (Node.js + TypeScript + Supabase RLS)

Arquitetura de backend Serverless em **Node.js + TypeScript** para plataforma SaaS de Logística, com isolamento Multi-Tenant via **Row Level Security (RLS)** no Supabase PostgreSQL (`location_id` e `user_id`), geração automática de identificadores duplos (**UUID v4** + **Short Code alfanumérico de 6–8 caracteres** para código de barras), precificação com link dinâmico do **Mercado Pago**, e orquestração de notificações no WhatsApp via **Evolution API** e **Chatwoot**.

---

## Arquitetura do Projeto

```text
├── supabase/
│   └── migrations/
│       └── 20261104000001_logistics_schema_rls.sql  # Schema PostgreSQL, Índices Covering e RLS
├── src/
│   ├── config/
│   │   └── env.ts                                   # Validação estrita de variáveis de ambiente (Zod)
│   ├── types/
│   │   └── logistics.ts                             # Contratos e tipagens estritas do domínio
│   ├── utils/
│   │   └── shortCode.ts                             # CSPRNG para UUID + Short Code (6-8 chars sem ambiguidade)
│   ├── lib/
│   │   └── supabase.ts                              # Clientes Supabase (Escopado RLS por JWT e Service Role)
│   ├── services/
│   │   ├── mercadopago.service.ts                   # Checkout Pro dinâmico, consulta de pagamento e validação HMAC
│   │   └── messaging.service.ts                     # Orquestração Evolution API (WhatsApp) + Chatwoot
│   ├── handlers/
│   │   ├── packages.handler.ts                      # Registro de pacotes, Scan de baixa latência e Precificação
│   │   └── webhooks.handler.ts                      # Webhook listener Mercado Pago (payment.created/updated)
│   └── index.ts                                     # Roteador Serverless / HTTP nativo de baixa latência
├── .env.example
├── package.json
└── tsconfig.json
```

---

## Endpoints Serverless

| Método | Rota | Descrição |
| :--- | :--- | :--- |
| `POST` | `/api/packages` | Registra pacotes gerando `id` (UUID) e `short_code` (6-8 chars alfanuméricos) sob isolamento RLS (`location_id` + `user_id`). |
| `GET` | `/api/packages/scan/:shortCode` | Resolução de leitura de código de barras em baixa latência via *Index-Only Scan* (`idx_packages_scan_resolution`). |
| `POST` | `/api/batches/:batchId/price` | Precifica um lote, gera link dinâmico do Mercado Pago e envia WhatsApp via Evolution API com remetente, volumes, valor e link. |
| `POST` | `/api/webhooks/mercadopago` | Listener seguro (`x-signature` HMAC-SHA256) para `payment.created` e `payment.updated`. Atualiza pacotes para `'Cleared for Delivery'` e envia confirmação via Evolution API / Chatwoot. |
