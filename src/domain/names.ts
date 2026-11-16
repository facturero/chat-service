import { createHash } from 'node:crypto';

/**
 * Nombres de canal al estilo Slack: minúsculas, sin espacios (se vuelven guiones), letras —con tildes y ñ—, números, `-` y `_`, hasta
 * 80. Se guarda así, normalizado, para que «Ventas Quito» y «ventas-quito» no sean dos canales que la gente confunde.
 *
 * `nameKey` además quita las tildes: es la clave única por organización, así «diseño» y «diseno» chocan (con colación
 * insensible a acentos MySQL también los igualaría y daría un 500 por UNIQUE; mejor decidirlo aquí y responder 409).
 */
export const GENERAL_NAME = 'general';
export const MAX_CHANNEL_NAME = 80;

export function normalizeChannelName(raw: string): string {
  return raw
    .trim()
    .toLocaleLowerCase('es')
    .replace(/^#+/, '')
    .replace(/\s+/g, '-')
    .replace(/[^\p{L}\p{N}_-]/gu, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_CHANNEL_NAME);
}

export function channelNameKey(name: string): string {
  return name.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
}

/** Clave de un DM: los participantes (incluida quien lo abre) ordenados. Mismas personas = misma conversación. */
export function dmKey(userIds: string[]): string {
  const ids = [...new Set(userIds.map((u) => u.toLowerCase()))].sort();
  return createHash('sha256').update(ids.join(',')).digest('hex');
}
