"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "messages",
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          channelId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "channels", key: "id" },
            onDelete: "CASCADE",
          },
          createdById: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "users", key: "id" },
          },
          // Same restricted ProseMirror JSON format as Comment.data, so
          // @-mentions (user/document/collection) work with no new parser.
          data: {
            type: Sequelize.JSONB,
            allowNull: false,
          },
          // Nullable, column added now so a reply-threading UI can land
          // later without a migration+backfill. No threading UI in v1.
          parentMessageId: {
            type: Sequelize.UUID,
            allowNull: true,
            references: { model: "messages", key: "id" },
            onDelete: "CASCADE",
          },
          // Set on edit; no separate revision history in v1 (see plan).
          editedAt: {
            type: Sequelize.DATE,
            allowNull: true,
          },
          createdAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
          updatedAt: {
            type: Sequelize.DATE,
            allowNull: false,
          },
          // Paranoid/soft-delete, same as comments - deleted messages
          // tombstone rather than disappear from the id space.
          deletedAt: {
            type: Sequelize.DATE,
            allowNull: true,
          },
        },
        { transaction }
      );

      // Scroll-back pagination within a channel.
      await queryInterface.addIndex("messages", ["channelId", "createdAt"], {
        transaction,
      });
      await queryInterface.addIndex("messages", ["parentMessageId"], {
        transaction,
      });
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("messages", { transaction });
    });
  },
};
