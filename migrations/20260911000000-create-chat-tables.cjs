module.exports = {
    async up (queryInterface, Sequelize) {

        /* 1.- Create conversations table */
        await queryInterface.createTable('conversations', {
            id: { type: Sequelize.CHAR(36), primaryKey: true },
            type: { type: Sequelize.ENUM('direct', 'group'), allowNull: false },
            title: { type: Sequelize.STRING(200), allowNull: true },
            created_by: { type: Sequelize.CHAR(36), allowNull: false },
            is_active: { type: Sequelize.BOOLEAN, allowNull: false, defaultValue: true },
            last_message_at: { type: Sequelize.DATE, allowNull: true },
            created_at: { type: Sequelize.DATE, allowNull: false },
            updated_at: { type: Sequelize.DATE, allowNull: false },
        });
        await queryInterface.addIndex('conversations', ['last_message_at']);

        /* 2.- Create conversation_participants table */
        await queryInterface.createTable('conversation_participants', {
            conversation_id: {
                type: Sequelize.CHAR(36),
                primaryKey: true,
                references: { model: 'conversations', key: 'id' },
                onDelete: 'CASCADE',
            },
            user_id: { type: Sequelize.CHAR(36), primaryKey: true },
            role: { type: Sequelize.ENUM('member', 'admin'), allowNull: false, defaultValue: 'member' },
            joined_at: { type: Sequelize.DATE, allowNull: false },
            last_read_at: { type: Sequelize.DATE, allowNull: true },
            left_at: { type: Sequelize.DATE, allowNull: true },
        });

        /* 3.- Create messages table */
        await queryInterface.createTable('messages', {
            id: { type: Sequelize.CHAR(36), primaryKey: true },
            conversation_id: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                references: { model: 'conversations', key: 'id' },
                onDelete: 'CASCADE',
            },
            sender_id: { type: Sequelize.CHAR(36), allowNull: false },
            content_type: {
                type: Sequelize.ENUM('text', 'image', 'audio', 'file'),
                allowNull: false,
                defaultValue: 'text',
            },
            content: { type: Sequelize.TEXT, allowNull: true },
            attachment_id: { type: Sequelize.CHAR(36), allowNull: true },
            attachment_url: { type: Sequelize.STRING(500), allowNull: true },
            status: {
                type: Sequelize.ENUM('sent', 'delivered', 'read', 'deleted'),
                allowNull: false,
                defaultValue: 'sent',
            },
            delivered_at: { type: Sequelize.DATE, allowNull: true },
            read_at: { type: Sequelize.DATE, allowNull: true },
            edited_at: { type: Sequelize.DATE, allowNull: true },
            reply_to: {
                type: Sequelize.CHAR(36),
                allowNull: true,
                references: { model: 'messages', key: 'id' },
                onDelete: 'SET NULL',
            },
            created_at: { type: Sequelize.DATE, allowNull: false },
        });
        await queryInterface.addIndex('messages', ['conversation_id', 'created_at']);

        /* 4.- Create participants_messages table */
        await queryInterface.createTable('participant_messages', {
            message_id: {
                type: Sequelize.CHAR(36),
                primaryKey: true,
                references: { model: 'messages', key: 'id' },
                onDelete: 'CASCADE',
            },
            participant_user_id: { type: Sequelize.CHAR(36), primaryKey: true },
            status: { type: Sequelize.ENUM('delivered', 'read'), allowNull: false },
            status_at: { type: Sequelize.DATE, allowNull: false },
        });

        /* 5.- Create message_versions table */
        await queryInterface.createTable('message_versions', {
            id: { type: Sequelize.CHAR(36), primaryKey: true },
            message_id: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                references: { model: 'messages', key: 'id' },
                onDelete: 'CASCADE',
            },
            content: { type: Sequelize.TEXT, allowNull: false },
            edited_by: { type: Sequelize.CHAR(36), allowNull: false },
            edited_at: { type: Sequelize.DATE, allowNull: false },
        });

        /* 6.- Create message_deletions table */
        await queryInterface.createTable('message_deletions', {
            id: { type: Sequelize.CHAR(36), primaryKey: true },
            message_id: {
                type: Sequelize.CHAR(36),
                allowNull: false,
                references: { model: 'messages', key: 'id' },
                onDelete: 'CASCADE',
            },
            deleted_by: { type: Sequelize.CHAR(36), allowNull: false },
            deleted_at: { type: Sequelize.DATE, allowNull: false },
        });

        /* 7.- Create outbox_messages table */
        await queryInterface.createTable('outbox_messages', {
            id: { type: Sequelize.CHAR(36), primaryKey: true },
            aggregate_type: { type: Sequelize.STRING(50), allowNull: false },
            aggregate_id: { type: Sequelize.CHAR(36), allowNull: false },
            type: { type: Sequelize.STRING(100), allowNull: false },
            payload: { type: Sequelize.JSON, allowNull: false },
            occurred_at: { type: Sequelize.DATE, allowNull: false },
            processed_at: { type: Sequelize.DATE, allowNull: true },
        });
        await queryInterface.addIndex('outbox_messages', ['processed_at']);

        /* 8.- Create processed_events table */
        await queryInterface.createTable('processed_events', {
            event_id: { type: Sequelize.CHAR(36), primaryKey: true },
            processed_at: { type: Sequelize.DATE, allowNull: false },
        });

    },

    async down(queryInterface) {
        await queryInterface.dropTable('processed_events');
        await queryInterface.dropTable('outbox_messages');
        await queryInterface.dropTable('message_deletions');
        await queryInterface.dropTable('message_versions');
        await queryInterface.dropTable('participant_messages');
        await queryInterface.dropTable('messages');
        await queryInterface.dropTable('conversation_participants');
        await queryInterface.dropTable('conversations');
    },
}