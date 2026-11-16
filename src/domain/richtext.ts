import { MAX_MESSAGE_CHARS, type RichDoc } from './types.js';
import { EMOJI_NAME } from './emojis.js';

/**
 * Texto enriquecido de los mensajes: un documento de TipTap (ProseMirror en JSON). Copia de `projects-service/src/domain/richtext.ts`
 * (la misma lista blanca: el frontend usa el mismo editor) con tres diferencias:
 *   - tope de 4000 caracteres (no 20 000): es un mensaje, no una descripción;
 *   - las menciones aceptan además `channel` (@canal) y `here` (@aquí) como id;
 *   - nodo `crmLink`: tarjeta de un cliente, factura, tarea, proyecto o producto del CRM. Solo se guarda qué es, su id y la etiqueta
 *     que se veía al insertarla; la tarjeta la completa el navegador con los permisos de quien mira (IMPLEMENTATION.md).
 *
 * El servidor NO se fía del documento: lo recorre y solo acepta la lista blanca. Lo que no está se rechaza (no se limpia en silencio).
 */
export class RichTextError extends Error {}

const BLOCKS = new Set(['doc', 'paragraph', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'codeBlock', 'table', 'tableRow', 'tableHeader', 'tableCell', 'image', 'file', 'crmLink']);
const CELLS = new Set(['tableHeader', 'tableCell']);
const MAX_SPAN = 20;
const INLINE = new Set(['text', 'hardBreak', 'mention', 'emoji']);
const MARKS = new Set(['bold', 'italic', 'strike', 'code', 'link']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SAFE_LINK = /^(https?:\/\/|mailto:)/i;
export const CRM_ENTITIES = ['customer', 'invoice', 'task', 'project', 'product'] as const;
export type CrmEntity = (typeof CRM_ENTITIES)[number];

const MAX_NODES = 2_000;
const MAX_DEPTH = 12;

export interface CrmLinkRef {
  entityType: CrmEntity;
  entityId: string;
  label: string;
}

export interface ParsedRichText {
  doc: RichDoc;
  text: string;
  /** @persona: ids de usuario, sin repetir. */
  mentions: string[];
  mentionsChannel: boolean;
  mentionsHere: boolean;
  crmLinks: CrmLinkRef[];
  /** Sin texto ni adjuntos ni tarjetas: no se envía. */
  isEmpty: boolean;
}

type Node = { type?: unknown; text?: unknown; attrs?: unknown; marks?: unknown; content?: unknown };

export function parseRichText(input: unknown): ParsedRichText {
  let nodes = 0;
  let chars = 0;
  let objects = 0; // imágenes, archivos y tarjetas: un mensaje con solo una imagen NO está vacío
  const mentions: string[] = [];
  let mentionsChannel = false;
  let mentionsHere = false;
  const crmLinks: CrmLinkRef[] = [];
  const lines: string[] = [];
  let line = '';
  let inCell = 0;

  const flush = () => {
    lines.push(line);
    line = '';
  };

  function walk(raw: unknown, depth: number): Record<string, unknown> {
    if (depth > MAX_DEPTH) throw new RichTextError('El texto está demasiado anidado.');
    if (++nodes > MAX_NODES) throw new RichTextError('El mensaje es demasiado largo.');
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new RichTextError('Formato de texto inválido.');
    const node = raw as Node;
    const type = node.type;
    if (typeof type !== 'string' || (!BLOCKS.has(type) && !INLINE.has(type))) throw new RichTextError(`Elemento no permitido: ${String(type)}`);

    const out: Record<string, unknown> = { type };

    if (type === 'text') {
      if (typeof node.text !== 'string' || node.text.length === 0) throw new RichTextError('Texto vacío.');
      chars += node.text.length;
      if (chars > MAX_MESSAGE_CHARS) throw new RichTextError(`Máximo ${MAX_MESSAGE_CHARS} caracteres.`);
      out.text = node.text;
      line += node.text;
      if (node.marks !== undefined) out.marks = walkMarks(node.marks);
      return out;
    }

    if (type === 'hardBreak') {
      flush();
      return out;
    }

    if (type === 'emoji') {
      // Emoji personalizado: solo su nombre. Si después lo borran, el navegador muestra `:nombre:` (no se valida aquí que exista).
      const attrs = (node.attrs ?? {}) as { name?: unknown };
      if (typeof attrs.name !== 'string' || !EMOJI_NAME.test(attrs.name)) throw new RichTextError('Emoji inválido.');
      out.attrs = { name: attrs.name };
      chars += attrs.name.length + 2;
      if (chars > MAX_MESSAGE_CHARS) throw new RichTextError(`Máximo ${MAX_MESSAGE_CHARS} caracteres.`);
      line += `:${attrs.name}:`;
      return out;
    }

    if (type === 'mention') {
      const attrs = (node.attrs ?? {}) as { id?: unknown; label?: unknown };
      const label = typeof attrs.label === 'string' ? attrs.label.slice(0, 120) : '';
      if (attrs.id === 'channel' || attrs.id === 'here') {
        if (attrs.id === 'channel') mentionsChannel = true;
        else mentionsHere = true;
        out.attrs = { id: attrs.id, label: attrs.id === 'channel' ? 'canal' : 'aquí' };
        line += attrs.id === 'channel' ? '@canal' : '@aquí';
        return out;
      }
      if (typeof attrs.id !== 'string' || !UUID.test(attrs.id)) throw new RichTextError('Mención inválida.');
      out.attrs = { id: attrs.id.toLowerCase(), label };
      if (!mentions.includes(attrs.id.toLowerCase())) mentions.push(attrs.id.toLowerCase());
      line += `@${label}`;
      return out;
    }

    if (type === 'image') {
      // El id del archivo en document-service, NO su URL: la URL firmada caduca y el navegador pide una nueva con su sesión.
      const attrs = (node.attrs ?? {}) as { documentId?: unknown; alt?: unknown };
      if (typeof attrs.documentId !== 'string' || !UUID.test(attrs.documentId)) throw new RichTextError('Imagen inválida.');
      out.attrs = { documentId: attrs.documentId.toLowerCase(), alt: typeof attrs.alt === 'string' ? attrs.alt.slice(0, 200) : '' };
      objects += 1;
      return out;
    }

    if (type === 'file') {
      const attrs = (node.attrs ?? {}) as { documentId?: unknown; name?: unknown; mimeType?: unknown };
      if (typeof attrs.documentId !== 'string' || !UUID.test(attrs.documentId)) throw new RichTextError('Archivo inválido.');
      const name = typeof attrs.name === 'string' && attrs.name.trim() ? attrs.name.trim().slice(0, 255) : 'archivo';
      const mimeType = typeof attrs.mimeType === 'string' ? attrs.mimeType.slice(0, 120) : '';
      out.attrs = { documentId: attrs.documentId.toLowerCase(), name, mimeType };
      if (line) flush();
      line = `[${name}]`;
      flush();
      objects += 1;
      return out;
    }

    if (type === 'crmLink') {
      const attrs = (node.attrs ?? {}) as { entityType?: unknown; entityId?: unknown; label?: unknown };
      if (typeof attrs.entityType !== 'string' || !(CRM_ENTITIES as readonly string[]).includes(attrs.entityType)) throw new RichTextError('Tarjeta del CRM inválida.');
      if (typeof attrs.entityId !== 'string' || !UUID.test(attrs.entityId)) throw new RichTextError('Tarjeta del CRM inválida.');
      const label = typeof attrs.label === 'string' && attrs.label.trim() ? attrs.label.trim().slice(0, 200) : attrs.entityType;
      const ref: CrmLinkRef = { entityType: attrs.entityType as CrmEntity, entityId: attrs.entityId.toLowerCase(), label };
      out.attrs = { ...ref };
      crmLinks.push(ref);
      if (line) flush();
      line = `[${label}]`;
      flush();
      objects += 1;
      return out;
    }

    if (CELLS.has(type) && node.attrs !== undefined) {
      const attrs = node.attrs as { colspan?: unknown; rowspan?: unknown; colwidth?: unknown };
      const span = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 1 && v <= MAX_SPAN ? v : 1);
      const widths = Array.isArray(attrs.colwidth) && attrs.colwidth.every((w) => typeof w === 'number' && Number.isInteger(w) && w > 0 && w <= 2000)
        ? (attrs.colwidth as number[]).slice(0, MAX_SPAN)
        : null;
      out.attrs = { colspan: span(attrs.colspan), rowspan: span(attrs.rowspan), colwidth: widths };
    }

    if (type === 'orderedList' && node.attrs !== undefined) {
      const start = (node.attrs as { start?: unknown }).start;
      if (typeof start === 'number' && Number.isInteger(start) && start > 0 && start < 10_000) out.attrs = { start };
    }

    if (node.content !== undefined) {
      if (!Array.isArray(node.content)) throw new RichTextError('Formato de texto inválido.');
      if (CELLS.has(type)) inCell += 1;
      out.content = node.content.map((child) => walk(child, depth + 1));
      if (CELLS.has(type)) inCell -= 1;
    }
    if (type === 'paragraph' || type === 'codeBlock') {
      if (inCell > 0) line += '\t';
      else flush();
    }
    if (type === 'tableRow') {
      line = line.replace(/\t+$/, '');
      flush();
    }
    return out;
  }

  function walkMarks(raw: unknown): Array<Record<string, unknown>> {
    if (!Array.isArray(raw)) throw new RichTextError('Formato de texto inválido.');
    return raw.map((m) => {
      const mark = m as { type?: unknown; attrs?: unknown };
      if (typeof mark.type !== 'string' || !MARKS.has(mark.type)) throw new RichTextError(`Formato no permitido: ${String(mark.type)}`);
      if (mark.type !== 'link') return { type: mark.type };
      const href = (mark.attrs as { href?: unknown } | undefined)?.href;
      if (typeof href !== 'string' || !SAFE_LINK.test(href) || href.length > 2000) throw new RichTextError('Enlace no permitido.');
      return { type: 'link', attrs: { href } };
    });
  }

  const doc = walk(input, 0);
  if (doc.type !== 'doc') throw new RichTextError('El mensaje debe ser un documento.');
  if (line) flush();
  const text = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  return { doc, text, mentions, mentionsChannel, mentionsHere, crmLinks, isEmpty: text.length === 0 && objects === 0 };
}

/** Mensaje de sistema («Ana se unió al canal»): el texto lo arma el frontend con el código y los parámetros, en su idioma. */
export function systemDoc(code: string, params: Record<string, string> = {}): RichDoc {
  return { type: 'doc', system: { code, params } };
}
