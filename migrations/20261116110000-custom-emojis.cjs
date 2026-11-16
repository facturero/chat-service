'use strict';

/**
 * Emojis personalizados (como los de Slack): cada organización sube imágenes y las usa con `:nombre:` en los mensajes y en las
 * reacciones. La imagen vive en document-service (`resourceType: chat_emoji`); aquí solo el nombre y el id del archivo.
 *
 * El nombre es único por organización (UNIQUE): dos personas subiendo `:fiesta:` a la vez → una gana, la otra recibe «ya existe».
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const id = { type: Sequelize.CHAR(36), allowNull: false };
    await queryInterface.createTable('custom_emojis', {
      id: { ...id, primaryKey: true },
      organization_id: id,
      name: { type: Sequelize.STRING(32), allowNull: false },
      document_id: id,
      created_by: id,
      created_at: { type: Sequelize.DATE, allowNull: false },
    });
    await queryInterface.addIndex('custom_emojis', ['organization_id', 'name'], { unique: true, name: 'uq_custom_emojis_org_name' });
  },

  async down(queryInterface) {
    await queryInterface.dropTable('custom_emojis');
  },
};
