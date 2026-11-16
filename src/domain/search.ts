/**
 * Búsqueda de mensajes (E4): solo en lo que la persona puede leer (sus conversaciones y los canales públicos), nunca un DM o un canal
 * privado ajeno, ni para `chat:admin` (decisión «privado, sin exportar»). Los borrados no salen (su texto ya es NULL).
 *
 * MySQL busca con el índice FULLTEXT de `body_text` en modo booleano: cada palabra es obligatoria y vale como prefijo («factu» encuentra
 * «facturas»). InnoDB no indexa palabras de menos de 3 letras (`innodb_ft_min_token_size`): esas se exigen con un LIKE aparte.
 */
export const MIN_FULLTEXT = 3;
const MAX_TERMS = 8;

/** Palabras de la búsqueda, sin los operadores del modo booleano (+ - < > ( ) ~ * " @) para que nadie arme una consulta rara. */
export function searchTerms(q: string): string[] {
  const words = q
    .toLocaleLowerCase('es')
    .split(/\s+/)
    .map((w) => w.replace(/[^\p{L}\p{N}_.-]/gu, '').replace(/^[.-]+|[.-]+$/g, ''))
    .filter((w) => w.length > 0);
  return [...new Set(words)].slice(0, MAX_TERMS);
}

/** Consulta booleana para `MATCH … AGAINST` con las palabras indexables; null si no hay ninguna (solo LIKE). */
export function booleanQuery(terms: string[]): string | null {
  // El guion y el punto parten palabras en el índice: «e-mail» se busca como sus trozos.
  const parts = terms.flatMap((t) => t.split(/[.-]+/)).filter((t) => t.length >= MIN_FULLTEXT);
  return parts.length ? parts.map((t) => `+${t}*`).join(' ') : null;
}

/** Palabras cortas que el índice no ve: se exigen con LIKE. */
export function shortTerms(terms: string[]): string[] {
  return terms.filter((t) => t.length < MIN_FULLTEXT);
}

/** Trozo del texto alrededor de la primera coincidencia (sin distinguir tildes ni mayúsculas), con «…» si se corta. */
export function snippet(text: string, terms: string[], radius = 70): string {
  const fold = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
  // NFD + quitar marcas mantiene la misma longitud que el texto original salvo caracteres compuestos raros: basta para cortar.
  const hay = fold(text);
  const at = terms.map((t) => hay.indexOf(fold(t))).filter((i) => i >= 0).sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - radius);
  const end = Math.min(text.length, at + radius);
  return `${start > 0 ? '…' : ''}${text.slice(start, end).replace(/\s+/g, ' ').trim()}${end < text.length ? '…' : ''}`;
}

/** Cursor opaco «más antiguos que este»: fecha y id del último resultado (los empates de fecha se rompen por id). */
export function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url');
}

export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  const [at, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  const createdAt = new Date(at ?? '');
  return id && !Number.isNaN(createdAt.getTime()) ? { createdAt, id } : null;
}
