'use strict';

/**
 * Vista «Hilos» (como la de Slack): cada seguidor de un hilo lleva su cursor de leído, el `thread_seq` de la última respuesta que vio.
 * Con él se cuentan las respuestas nuevas y las menciones dentro de los hilos que sigue (IMPLEMENTATION.md, «Hilos»).
 *
 * - `last_read_thread_seq` arranca en 0: para quien ya seguía un hilo, todas sus respuestas cuentan como no leídas hasta abrirlo
 *   (en producción aún no hay hilos: el chat no está subido).
 * - Índice por persona: la vista lista los hilos de UNA persona; la clave primaria empieza por el hilo y no sirve para eso.
 */
/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.addColumn('thread_followers', 'last_read_thread_seq', { type: Sequelize.INTEGER.UNSIGNED, allowNull: false, defaultValue: 0 });
    await queryInterface.addIndex('thread_followers', ['user_id', 'organization_id'], { name: 'ix_thread_followers_user' });
  },

  async down(queryInterface) {
    await queryInterface.removeIndex('thread_followers', 'ix_thread_followers_user');
    await queryInterface.removeColumn('thread_followers', 'last_read_thread_seq');
  },
};
