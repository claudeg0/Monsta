"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "channel_memberships",
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
          userId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "users", key: "id" },
            onDelete: "CASCADE",
          },
          // Read-cursor for unread tracking, not a per-message read receipt.
          lastReadAt: {
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
        },
        { transaction }
      );

      // A user can only belong to a given channel once.
      await queryInterface.addIndex(
        "channel_memberships",
        ["channelId", "userId"],
        { unique: true, transaction }
      );
      // "Which channels is this user in" lookups (e.g. on socket connect).
      await queryInterface.addIndex("channel_memberships", ["userId"], {
        transaction,
      });
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("channel_memberships", { transaction });
    });
  },
};
