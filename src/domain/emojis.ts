/**
 * Emojis personalizados: nombre corto en minúsculas (letras, números, `_`, `+`, `-`), de 2 a 32, como los de Slack. Se escriben
 * `:nombre:` en el texto y en las reacciones.
 */
export const EMOJI_NAME = /^[a-z0-9_+-]{2,32}$/;
const CUSTOM_REACTION = /^:([a-z0-9_+-]{2,32}):$/;

/** «Fiesta Ñandú.png» → «fiesta_nandu». Lo que no se puede usar se quita; puede quedar vacío (y el caso de uso lo rechaza). */
export function normalizeEmojiName(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^:+|:+$/g, '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .replace(/\s+/g, '_')
    .replace(/[^a-z0-9_+-]/g, '')
    .slice(0, 32);
}

/** `:fiesta:` → `fiesta`; un emoji normal (😀) → null. */
export function customReactionName(emoji: string): string | null {
  return emoji.match(CUSTOM_REACTION)?.[1] ?? null;
}
