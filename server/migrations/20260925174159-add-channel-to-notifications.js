"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // Chat notifications reference their channel instead of a document -
      // documentId/commentId stay null on these rows. All existing
      // notification types leave this null.
      await queryInterface.addColumn(
        "notifications",
        "channelId",
        {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: "channels", key: "id" },
        },
        { transaction }
      );

      // Serves the aggregation lookup exactly: event = 'channels.message'
      // AND userId = ? AND channelId = ? AND viewedAt IS NULL.
      await queryInterface.addIndex(
        "notifications",
        ["userId", "channelId", "viewedAt"],
        { transaction }
      );

      // One live chat notification per (user, channel) - viewed rows fall
      // outside the constraint, so chat notification history is allowed to
      // accumulate and be pruned by the cleanup task.
      await queryInterface.addIndex(
        "notifications",
        ["userId", "channelId"],
        {
          unique: true,
          where: { event: "channels.message", viewedAt: null },
          transaction,
        }
      );
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex(
        "notifications",
        ["userId", "channelId"],
        { transaction }
      );
      await queryInterface.removeIndex(
        "notifications",
        ["userId", "channelId", "viewedAt"],
        { transaction }
      );
      await queryInterface.removeColumn("notifications", "channelId", {
        transaction,
      });
    });
  },
};
