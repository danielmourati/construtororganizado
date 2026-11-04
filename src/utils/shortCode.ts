import { randomBytes, randomUUID } from 'node:crypto';

/**
 * Alfabeto Criptográfico para Código de Barras (Code-128 / QR)
 * Exclui caracteres visualmente ambíguos (0, O, 1, I, L) para leitura óptica/manual rápida.
 */
const BARCODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const ALPHABET_LEN = BARCODE_ALPHABET.length;

export interface GeneratedPackageIdentifiers {
  readonly id: string;
  readonly shortCode: string;
}

/**
 * Gera um código curto alfanumérico de 6 a 8 caracteres usando entropia criptográfica (CSPRNG).
 * @param length Comprimento entre 6 e 8 caracteres (padrão: 7)
 */
export function generateShortCode(length: 6 | 7 | 8 = 7): string {
  const bytes = randomBytes(length);
  let code = '';

  for (let i = 0; i < length; i++) {
    const byte = bytes[i] ?? 0;
    code += BARCODE_ALPHABET[byte % ALPHABET_LEN];
  }

  return code;
}

/**
 * Gera simultaneamente o UUID v4 relacional e o short_code de 6-8 caracteres
 * para mapeamento imediato em etiquetas de código de barras.
 */
export function generatePackageIdentifiers(shortCodeLength: 6 | 7 | 8 = 7): GeneratedPackageIdentifiers {
  return {
    id: randomUUID(),
    shortCode: generateShortCode(shortCodeLength),
  };
}

