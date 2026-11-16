'use strict';

/**
 * Modelo de mensajería al estilo Slack (IMPLEMENTATION.md → «Modelo de datos»). Reemplaza el esqueleto anterior, estilo WhatsApp
 * (`20260911000000-create-chat-tables.cjs`), que corrió en producción pero nunca tuvo uso: no hay datos que conservar.
 *
 * - NO se edita la migración vieja (ya aplicada): esta borra sus tablas y crea las nuevas.
 * - `outbox_messages` se conserva (su forma es la de @facturero/outbox-relay). `processed_events` se rehace: la vieja solo tenía
 *   `event_id` y el InboxConsumer 0.2.x necesita `event_type`, `routing_key`, `payload`, `status` y `last_error`.
 * - Antes de borrar comprueba que las tablas viejas están VACÍAS; si alguna tiene filas, se detiene (no se borran datos de nadie).
 *
 * Personas y organización son ids de auth-service: sin FOREIGN KEY entre servicios. Los textos van en utf8mb4.
 */
const OLD_TABLES = ['message_deletions', 'message_versions', 'participant_messages', 'messages', 'conversation_participants', 'conversations'];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const existing = new Set((await queryInterface.showAllTables()).map((t) => (typeof t === 'string' ? t : t.tableName)));
    for (const table of OLD_TABLES) {
      if (!existing.has(table)) continue;
      const [[row]] = await queryInterface.sequelize.query(`SELECT COUNT(*) AS n FROM \`${table}\``);
      if (Number(row.n) > 0) throw new Error(`La tabla vieja ${table} tiene ${row.n} filas: no se borra. Revisar a mano antes de migrar.`);
    }
    for (const table of OLD_TABLES) if (existing.has(table)) await queryInterface.dropTable(table);
    if (existing.has('processed_events')) await queryInterface.dropTable('processed_events');

    const id = { type: Sequelize.CHAR(36), allowNull: false };

    await queryInterface.createTable('conversations', {
      id: { ...id, primaryKey: true },
      organization_id: id,
      kind: { type: Sequelize.ENUM('channel', 'dm', 'group_dm'), allowNull: false },
      visibility: { type: Sequelize.ENUM('public', 'private'), allowNull: true },
      name: { type: Sequelize.STRING(80), allowNull: true },
      // Minúsculas sin tildes: «diseño» y «diseno» son el mismo canal. NULL en DMs (MySQL permite varios NULL en un UNIQUE).
      name_key: { type: Sequelize.STRING(80), allowNull: true },
      topic: { type: Sequelize.STRING(250), allowNull: true },
      description: { type: Sequelize.STRING(1000), allowNull: true },
      is_general: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      dm_key: { type: Sequelize.CHAR(64), allowNull: true },
      created_by: id,
      archived_at: { type: Sequelize.DATE, allowNull: true },
      message_seq: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      last_message_at: { type: Sequelize.DATE, allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
      updated_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('conversations', ['organization_id', 'name_key'], { unique: true, name: 'uq_conversations_org_name' });
    await queryInterface.addIndex('conversations', ['organization_id', 'dm_key'], { unique: true, name: 'uq_conversations_org_dm' });
    await queryInterface.addIndex('conversations', ['organization_id', 'kind', 'visibility'], { name: 'ix_conversations_browse' });

    await queryInterface.createTable('conversation_members', {
      conversation_id: { ...id, primaryKey: true, references: { model: 'conversations', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { ...id, primaryKey: true },
      organization_id: id,
      role: { type: Sequelize.ENUM('owner', 'member'), allowNull: false, defaultValue: 'member' },
      notify: { type: Sequelize.ENUM('all', 'mentions', 'none'), allowNull: false, defaultValue: 'mentions' },
      muted: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: false },
      last_read_seq: { type: Sequelize.BIGINT, allowNull: false, defaultValue: 0 },
      joined_at: { type: Sequelize.DATE, allowNull: false },
    });
    // La barra lateral: «mis conversaciones en esta organización».
    await queryInterface.addIndex('conversation_members', ['organization_id', 'user_id'], { name: 'ix_members_user' });

    await queryInterface.createTable('messages', {
      id: { ...id, primaryKey: true },
      organization_id: id,
      conversation_id: { ...id, references: { model: 'conversations', key: 'id' }, onDelete: 'CASCADE' },
      seq: { type: Sequelize.BIGINT, allowNull: true },
      thread_root_id: { type: Sequelize.CHAR(36), allowNull: true },
      thread_seq: { type: Sequelize.BIGINT, allowNull: true },
      sender_id: { type: Sequelize.CHAR(36), allowNull: true },
      kind: { type: Sequelize.ENUM('user', 'system'), allowNull: false, defaultValue: 'user' },
      body_doc: { type: Sequelize.JSON, allowNull: true },
      body_text: { type: Sequelize.TEXT, allowNull: true },
      client_msg_id: { type: Sequelize.CHAR(36), allowNull: true },
      reply_count: { type: Sequelize.INTEGER, allowNull: false, defaultValue: 0 },
      last_reply_at: { type: Sequelize.DATE, allowNull: true },
      reply_user_ids: { type: Sequelize.JSON, allowNull: true },
      edited_at: { type: Sequelize.DATE, allowNull: true },
      deleted_at: { type: Sequelize.DATE, allowNull: true },
      deleted_by: { type: Sequelize.CHAR(36), allowNull: true },
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    // El orden y la paginación van por estos números; los UNIQUE son la red que impide dos mensajes con el mismo número.
    await queryInterface.addIndex('messages', ['conversation_id', 'seq'], { unique: true, name: 'uq_messages_seq' });
    await queryInterface.addIndex('messages', ['thread_root_id', 'thread_seq'], { unique: true, name: 'uq_messages_thread_seq' });
    await queryInterface.addIndex('messages', ['conversation_id', 'client_msg_id'], { unique: true, name: 'uq_messages_client' });
    await queryInterface.sequelize.query('ALTER TABLE messages ADD FULLTEXT INDEX ft_messages_body (body_text)');

    await queryInterface.createTable('message_reactions', {
      message_id: { ...id, primaryKey: true, references: { model: 'messages', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { ...id, primaryKey: true },
      emoji: { type: Sequelize.STRING(64), allowNull: false, primaryKey: true },
      organization_id: id,
      created_at: { type: Sequelize.DATE, allowNull: false },
    });

    await queryInterface.createTable('message_mentions', {
      message_id: { ...id, primaryKey: true, references: { model: 'messages', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { ...id, primaryKey: true },
      organization_id: id,
      conversation_id: id,
      kind: { type: Sequelize.ENUM('user', 'channel', 'here'), allowNull: false },
    });
    await queryInterface.addIndex('message_mentions', ['user_id', 'conversation_id'], { name: 'ix_mentions_user' });

    await queryInterface.createTable('thread_followers', {
      thread_root_id: { ...id, primaryKey: true, references: { model: 'messages', key: 'id' }, onDelete: 'CASCADE' },
      user_id: { ...id, primaryKey: true },
      organization_id: id,
    });

    await queryInterface.createTable('inactive_users', {
      organization_id: { ...id, primaryKey: true },
      user_id: { ...id, primaryKey: true },
      since: { type: Sequelize.DATE, allowNull: false },
    });

    if (!existing.has('outbox_messages')) {
      await queryInterface.createTable('outbox_messages', {
        id: { ...id, primaryKey: true },
        aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
        aggregate_id: id,
        type: { type: Sequelize.STRING(100), allowNull: false },
        payload: { type: Sequelize.JSON, allowNull: false },
        occurred_at: { type: Sequelize.DATE, allowNull: false },
        processed_at: { type: Sequelize.DATE, allowNull: true },
      });
      await queryInterface.addIndex('outbox_messages', ['processed_at']);
    }

    await queryInterface.createTable('processed_events', {
      id: { ...id, primaryKey: true },
      event_type: { type: Sequelize.STRING(100), allowNull: false },
      routing_key: { type: Sequelize.STRING(200), allowNull: false },
      payload: { type: Sequelize.JSON, allowNull: false },
      status: { type: Sequelize.STRING(20), allowNull: false, defaultValue: 'processed' },
      last_error: { type: Sequelize.TEXT, allowNull: true },
      processed_at: { type: Sequelize.DATE, allowNull: false },
    });
  },

  async down(queryInterface) {
    // Vuelve a un esquema vacío (no recrea el modelo viejo: nunca se usó).
    for (const table of ['processed_events', 'inactive_users', 'thread_followers', 'message_mentions', 'message_reactions', 'messages', 'conversation_members', 'conversations']) {
      await queryInterface.dropTable(table);
    }
  },
};
