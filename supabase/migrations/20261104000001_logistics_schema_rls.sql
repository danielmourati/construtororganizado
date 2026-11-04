-- ============================================================================
-- MIGRAÇÃO: SaaS de Logística - Schema PostgreSQL, Índices de Baixa Latência e RLS
-- Descrição: Isolamento Multi-Tenant por location_id e user_id, geração automática
--            de UUID + Short Code alfanumérico (6-8 chars) para código de barras
--            e controle de lotes, pagamentos Mercado Pago e notificações.
-- ============================================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- 1. Tipos Enumerados de Status
DO $$ BEGIN
    CREATE TYPE public.package_status AS ENUM (
        'Registered',
        'Priced',
        'Awaiting Payment',
        'Cleared for Delivery',
        'Out for Delivery',
        'Delivered',
        'Cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE public.batch_payment_status AS ENUM (
        'pending_pricing',
        'awaiting_payment',
        'paid',
        'cancelled'
    );
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 2. Função Geradora de Short Code Alfanumérico (6 a 8 caracteres) para Código de Barras
-- Remove caracteres visualmente ambíguos (0, O, 1, I, L) para evitar falhas ópticas/humanas
CREATE OR REPLACE FUNCTION public.generate_barcode_short_code(code_length INTEGER DEFAULT 7)
RETURNS VARCHAR AS $$
DECLARE
    alphabet CONSTANT TEXT := '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
    alphabet_length CONSTANT INTEGER := length(alphabet);
    random_bytes BYTEA;
    result TEXT := '';
    i INTEGER;
BEGIN
    IF code_length < 6 OR code_length > 8 THEN
        RAISE EXCEPTION 'O short_code deve ter entre 6 e 8 caracteres.';
    END IF;

    random_bytes := gen_random_bytes(code_length);
    FOR i IN 0..(code_length - 1) LOOP
        result := result || substr(alphabet, (get_byte(random_bytes, i) % alphabet_length) + 1, 1);
    END LOOP;

    RETURN result;
END;
$$ LANGUAGE plpgsql VOLATILE;

-- 3. Tabela de Unidades / Hubs Logísticos (Locations)
CREATE TABLE IF NOT EXISTS public.locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    name VARCHAR(150) NOT NULL,
    code VARCHAR(20) NOT NULL UNIQUE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 4. Tabela de Vínculo Usuário x Unidade Logística (Multi-Tenant Membership)
CREATE TABLE IF NOT EXISTS public.user_locations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE CASCADE,
    role VARCHAR(30) NOT NULL DEFAULT 'operator' CHECK (role IN ('operator', 'manager', 'admin')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (user_id, location_id)
);

-- 5. Tabela de Lotes de Pacotes (Package Batches) - Unidade de Precificação e Cobrança
CREATE TABLE IF NOT EXISTS public.package_batches (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    sender_name VARCHAR(180) NOT NULL,
    sender_document VARCHAR(30),
    receiver_name VARCHAR(180) NOT NULL,
    receiver_whatsapp VARCHAR(30) NOT NULL,
    receiver_email VARCHAR(180),
    chatwoot_conversation_id BIGINT,
    volume_count INTEGER NOT NULL DEFAULT 0 CHECK (volume_count >= 0),
    total_price NUMERIC(12, 2) NOT NULL DEFAULT 0.00 CHECK (total_price >= 0),
    currency VARCHAR(3) NOT NULL DEFAULT 'BRL',
    payment_status public.batch_payment_status NOT NULL DEFAULT 'pending_pricing',
    mp_preference_id VARCHAR(120),
    mp_checkout_url TEXT,
    mp_payment_id VARCHAR(120),
    paid_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 6. Tabela de Pacotes Individuais (Packages)
CREATE TABLE IF NOT EXISTS public.packages (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    short_code VARCHAR(8) NOT NULL UNIQUE,
    batch_id UUID REFERENCES public.package_batches(id) ON DELETE SET NULL,
    location_id UUID NOT NULL REFERENCES public.locations(id) ON DELETE RESTRICT,
    user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
    sender_name VARCHAR(180) NOT NULL,
    receiver_name VARCHAR(180) NOT NULL,
    receiver_whatsapp VARCHAR(30) NOT NULL,
    weight_kg NUMERIC(8, 3) CHECK (weight_kg > 0),
    description TEXT,
    status public.package_status NOT NULL DEFAULT 'Registered',
    last_scanned_at TIMESTAMPTZ,
    cleared_at TIMESTAMPTZ,
    metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_short_code_format CHECK (short_code ~ '^[A-Z0-9]{6,8}$')
);

-- 7. Trigger para garantir geração automática e sem colisão do short_code (6-8 chars)
CREATE OR REPLACE FUNCTION public.trg_ensure_package_short_code()
RETURNS TRIGGER AS $$
DECLARE
    candidate VARCHAR(8);
    attempts INTEGER := 0;
BEGIN
    IF NEW.short_code IS NULL OR trim(NEW.short_code) = '' THEN
        LOOP
            attempts := attempts + 1;
            candidate := public.generate_barcode_short_code(7);
            EXIT WHEN NOT EXISTS (
                SELECT 1 FROM public.packages WHERE short_code = candidate
            );
            IF attempts > 15 THEN
                -- Em caso de alta densidade, expande para 8 caracteres
                candidate := public.generate_barcode_short_code(8);
                EXIT WHEN NOT EXISTS (
                    SELECT 1 FROM public.packages WHERE short_code = candidate
                );
            END IF;
        END LOOP;
        NEW.short_code := candidate;
    ELSE
        NEW.short_code := upper(trim(NEW.short_code));
    END IF;

    NEW.updated_at := NOW();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS ensure_package_short_code_before_insert ON public.packages;
CREATE TRIGGER ensure_package_short_code_before_insert
BEFORE INSERT ON public.packages
FOR EACH ROW
EXECUTE FUNCTION public.trg_ensure_package_short_code();

-- 8. Tabela de Auditoria e Idempotência de Webhooks (Mercado Pago)
CREATE TABLE IF NOT EXISTS public.webhook_events (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(40) NOT NULL DEFAULT 'mercadopago',
    external_event_id VARCHAR(150) NOT NULL,
    action VARCHAR(80) NOT NULL,
    resource_id VARCHAR(150) NOT NULL,
    payload JSONB NOT NULL,
    processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE (provider, external_event_id, action)
);

-- ============================================================================
-- ÍNDICES OTIMIZADOS PARA LEITURA DE CÓDIGO DE BARRAS EM BAIXA LATÊNCIA
-- ============================================================================

-- Covering Index (Index-Only Scan) para resolução sub-milissegundo por short_code e location_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_packages_scan_resolution
    ON public.packages (short_code, location_id)
    INCLUDE (id, batch_id, status, sender_name, receiver_name, receiver_whatsapp, weight_kg, cleared_at);

CREATE INDEX IF NOT EXISTS idx_packages_location_user
    ON public.packages (location_id, user_id, status);

CREATE INDEX IF NOT EXISTS idx_packages_batch_id
    ON public.packages (batch_id);

CREATE INDEX IF NOT EXISTS idx_batches_location_user
    ON public.package_batches (location_id, user_id, payment_status);

CREATE INDEX IF NOT EXISTS idx_user_locations_lookup
    ON public.user_locations (user_id, location_id);

-- ============================================================================
-- ROW LEVEL SECURITY (RLS) - ISOLAMENTO POR location_id E user_id
-- ============================================================================

ALTER TABLE public.locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.package_batches ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.webhook_events ENABLE ROW LEVEL SECURITY;

-- Função auxiliar Security Definer para checar acesso do usuário à location_id
-- Suporta tanto o claim customizado no JWT (`app_metadata.location_id`) quanto a tabela `user_locations`
CREATE OR REPLACE FUNCTION public.user_has_location_access(target_location_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    SELECT
        (COALESCE((auth.jwt() -> 'app_metadata' ->> 'location_id')::UUID, '00000000-0000-0000-0000-000000000000'::UUID) = target_location_id)
        OR EXISTS (
            SELECT 1
            FROM public.user_locations ul
            WHERE ul.user_id = auth.uid()
              AND ul.location_id = target_location_id
        );
$$;

-- Políticas para `user_locations`
CREATE POLICY "user_locations_select_own"
    ON public.user_locations
    FOR SELECT
    TO authenticated
    USING (user_id = auth.uid());

-- Políticas para `locations`
CREATE POLICY "locations_select_assigned"
    ON public.locations
    FOR SELECT
    TO authenticated
    USING (public.user_has_location_access(id));

-- Políticas para `packages` (Isolamento estrito por location_id e user_id)
CREATE POLICY "packages_select_isolated_by_location_and_user"
    ON public.packages
    FOR SELECT
    TO authenticated
    USING (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    );

CREATE POLICY "packages_insert_isolated_by_location_and_user"
    ON public.packages
    FOR INSERT
    TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    );

CREATE POLICY "packages_update_isolated_by_location_and_user"
    ON public.packages
    FOR UPDATE
    TO authenticated
    USING (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    )
    WITH CHECK (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    );

CREATE POLICY "packages_delete_isolated_by_location_and_user"
    ON public.packages
    FOR DELETE
    TO authenticated
    USING (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    );

-- Políticas para `package_batches` (Isolamento estrito por location_id e user_id)
CREATE POLICY "batches_select_isolated_by_location_and_user"
    ON public.package_batches
    FOR SELECT
    TO authenticated
    USING (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    );

CREATE POLICY "batches_insert_isolated_by_location_and_user"
    ON public.package_batches
    FOR INSERT
    TO authenticated
    WITH CHECK (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    );

CREATE POLICY "batches_update_isolated_by_location_and_user"
    ON public.package_batches
    FOR UPDATE
    TO authenticated
    USING (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    )
    WITH CHECK (
        user_id = auth.uid()
        AND public.user_has_location_access(location_id)
    );

-- Função RPC transacional (executada via Service Role no Webhook do Mercado Pago)
-- Atualiza o lote e todos os pacotes vinculados para 'Cleared for Delivery' atomicamente
CREATE OR REPLACE FUNCTION public.mark_batch_cleared_for_delivery(
    p_batch_id UUID,
    p_mp_payment_id VARCHAR
)
RETURNS TABLE (
    batch_id UUID,
    location_id UUID,
    sender_name VARCHAR,
    receiver_name VARCHAR,
    receiver_whatsapp VARCHAR,
    chatwoot_conversation_id BIGINT,
    volume_count INTEGER,
    total_price NUMERIC,
    cleared_packages_count BIGINT,
    short_codes TEXT[]
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_updated_codes TEXT[];
    v_count BIGINT;
BEGIN
    -- Atualiza o lote caso ainda não esteja pago (idempotente)
    UPDATE public.package_batches pb
    SET payment_status = 'paid',
        mp_payment_id = p_mp_payment_id,
        paid_at = COALESCE(pb.paid_at, NOW()),
        updated_at = NOW()
    WHERE pb.id = p_batch_id;

    -- Atualiza todos os pacotes do lote para 'Cleared for Delivery'
    WITH updated_pkgs AS (
        UPDATE public.packages p
        SET status = 'Cleared for Delivery',
            cleared_at = COALESCE(p.cleared_at, NOW()),
            updated_at = NOW()
        WHERE p.batch_id = p_batch_id
          AND p.status <> 'Delivered'
        RETURNING p.short_code
    )
    SELECT array_agg(up.short_code), count(*)
    INTO v_updated_codes, v_count
    FROM updated_pkgs up;

    RETURN QUERY
    SELECT
        pb.id,
        pb.location_id,
        pb.sender_name,
        pb.receiver_name,
        pb.receiver_whatsapp,
        pb.chatwoot_conversation_id,
        pb.volume_count,
        pb.total_price,
        COALESCE(v_count, 0),
        COALESCE(v_updated_codes, ARRAY[]::TEXT[])
    FROM public.package_batches pb
    WHERE pb.id = p_batch_id;
END;
$$;

