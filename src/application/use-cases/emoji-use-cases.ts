import { isAdmin } from '../../domain/access.js';
import { EMOJI_NAME, normalizeEmojiName } from '../../domain/emojis.js';
import { EmojiNotFoundError, ForbiddenError, NameTakenError, ValidationError } from '../../domain/errors.js';
import type { Repositories } from '../../domain/repositories.js';
import type { Actor, CustomEmoji } from '../../domain/types.js';
import type { Clock, IdGenerator } from '../ports.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Tope por organización: el selector se vuelve inmanejable mucho antes, y cada uno es una imagen que el navegador pide. */
export const MAX_EMOJIS = 500;

/**
 * Emojis personalizados de la organización (como en Slack): cualquiera del equipo agrega uno; lo quita quien lo subió o `chat:admin`.
 * La imagen la sube el navegador a document-service (`resourceType: chat_emoji`) y aquí se guarda su id. Quitar un emoji no toca los
 * mensajes: donde se usó, el navegador muestra `:nombre:`.
 */
export class EmojiUseCases {
  constructor(
    private readonly repos: Repositories,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  list(actor: Actor): Promise<CustomEmoji[]> {
    return this.repos.emojis.list(actor.organizationId);
  }

  async create(actor: Actor, input: { name: string; documentId: string }): Promise<CustomEmoji> {
    const name = normalizeEmojiName(input.name);
    if (!EMOJI_NAME.test(name)) throw new ValidationError([{ field: 'name', message: 'El nombre lleva de 2 a 32 letras, números, «_», «+» o «-».' }]);
    if (!UUID.test(input.documentId)) throw new ValidationError([{ field: 'documentId', message: 'Imagen inválida.' }]);
    if ((await this.repos.emojis.list(actor.organizationId)).length >= MAX_EMOJIS) {
      throw new ValidationError([{ field: 'name', message: `La organización ya tiene ${MAX_EMOJIS} emojis: quita alguno antes de agregar otro.` }]);
    }
    const emoji: CustomEmoji = {
      id: this.ids(),
      organizationId: actor.organizationId,
      name,
      documentId: input.documentId.toLowerCase(),
      createdBy: actor.userId,
      createdAt: this.clock(),
    };
    // El UNIQUE (organización, nombre) decide quién se queda con el nombre si dos lo suben a la vez.
    if (!(await this.repos.emojis.insertIfAbsent(emoji))) throw new NameTakenError(`Ya existe el emoji :${name}:.`);
    return emoji;
  }

  async remove(actor: Actor, id: string): Promise<void> {
    const emoji = await this.repos.emojis.findById(actor.organizationId, id);
    if (!emoji) throw new EmojiNotFoundError();
    if (emoji.createdBy !== actor.userId && !isAdmin(actor)) throw new ForbiddenError('Solo quien lo subió o un administrador del chat puede quitarlo.');
    await this.repos.emojis.remove(actor.organizationId, id);
  }
}
