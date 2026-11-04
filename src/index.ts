import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { URL } from 'node:url';
import {
  handleBarcodeScanResolution,
  handlePriceBatchAndDispatchWhatsApp,
  handleRegisterPackages,
} from './handlers/packages.handler.js';
import { handleMercadoPagoWebhook } from './handlers/webhooks.handler.js';
import { HttpError } from './lib/supabase.js';

/**
 * Lê e faz o parse seguro do corpo JSON da requisição com limite de tamanho.
 */
async function parseJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let totalBytes = 0;
    const MAX_BYTES = 1024 * 512; // 512 KB

    req.on('data', (chunk: Buffer) => {
      totalBytes += chunk.length;
      if (totalBytes > MAX_BYTES) {
        reject(new HttpError(413, 'Payload excede o limite máximo permitido (512KB).'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });

    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new HttpError(400, 'Corpo da requisição não é um JSON válido.'));
      }
    });

    req.on('error', (err) => reject(err));
  });
}

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

/**
 * Handler Serverless Principal (compatível com Vercel Serverless Functions e Node HTTP)
 */
export async function serverlessRequestHandler(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  const method = req.method ?? 'GET';
  const parsedUrl = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  const pathname = parsedUrl.pathname.replace(/\/+$/, '') || '/';

  const authorizationHeader =
    typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : undefined;
  const locationHeader =
    typeof req.headers['x-location-id'] === 'string' ? req.headers['x-location-id'] : undefined;

  try {
    // Healthcheck de baixa latência
    if (method === 'GET' && pathname === '/api/health') {
      sendJson(res, 200, { status: 'ok', timestamp: new Date().toISOString() });
      return;
    }

    // 1. POST /api/packages -> Registro de Pacotes (gera UUID + Short Code 6-8 chars)
    if (method === 'POST' && pathname === '/api/packages') {
      const body = await parseJsonBody(req);
      const result = await handleRegisterPackages({
        authorizationHeader,
        locationHeader,
        body,
      });
      sendJson(res, 201, {
        success: true,
        data: result,
      });
      return;
    }

    // 2. GET /api/packages/scan/:shortCode -> Resolução de Código de Barras em Baixa Latência
    const scanMatch = /^\/api\/packages\/scan\/([A-Za-z0-9]{6,8})$/.exec(pathname);
    if (method === 'GET' && scanMatch && scanMatch[1]) {
      const result = await handleBarcodeScanResolution({
        authorizationHeader,
        locationHeader,
        shortCode: scanMatch[1],
      });
      sendJson(res, 200, {
        success: true,
        data: result,
      });
      return;
    }

    // 3. POST /api/batches/:batchId/price -> Precificação de Lote + Checkout MP + WhatsApp Evolution API
    const priceMatch =
      /^\/api\/batches\/([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\/price$/.exec(
        pathname
      );
    if (method === 'POST' && priceMatch && priceMatch[1]) {
      const body = await parseJsonBody(req);
      const result = await handlePriceBatchAndDispatchWhatsApp({
        authorizationHeader,
        locationHeader,
        batchId: priceMatch[1],
        body,
      });
      sendJson(res, 200, {
        success: true,
        data: result,
      });
      return;
    }

    // 4. POST /api/webhooks/mercadopago -> Webhook Seguro Mercado Pago (payment.created / payment.updated)
    if (method === 'POST' && pathname === '/api/webhooks/mercadopago') {
      const body = await parseJsonBody(req);
      const xSignatureHeader =
        typeof req.headers['x-signature'] === 'string' ? req.headers['x-signature'] : undefined;
      const xRequestIdHeader =
        typeof req.headers['x-request-id'] === 'string' ? req.headers['x-request-id'] : undefined;
      const queryDataId = parsedUrl.searchParams.get('data.id') ?? undefined;

      const result = await handleMercadoPagoWebhook({
        xSignatureHeader,
        xRequestIdHeader,
        queryDataId,
        body,
      });

      sendJson(res, 200, {
        success: true,
        data: result,
      });
      return;
    }

    sendJson(res, 404, {
      success: false,
      error: `Rota não encontrada: ${method} ${pathname}`,
    });
  } catch (error) {
    if (error instanceof HttpError) {
      sendJson(res, error.statusCode, {
        success: false,
        error: error.message,
      });
      return;
    }

    const message = error instanceof Error ? error.message : 'Erro interno inesperado.';
    console.error('[Erro na Requisição]:', error);
    sendJson(res, 500, {
      success: false,
      error: message,
    });
  }
}

export default serverlessRequestHandler;

// Inicialização standalone quando executado diretamente via Node.js
if (process.env['NODE_ENV'] !== 'test' && !process.env['VERCEL']) {
  const port = Number(process.env['PORT'] ?? 3000);
  const server = createServer((req, res) => {
    void serverlessRequestHandler(req, res);
  });

  server.listen(port, () => {
    console.log(`[SaaS Logística] Servidor HTTP/Serverless ativo na porta ${port}`);
  });
}

