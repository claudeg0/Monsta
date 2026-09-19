"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // Per-viewer, like lastReadAt beside it: hiding a conversation removes
      // it from your own list without touching anyone else's copy or deleting
      // a single message. Null means visible.
      //
      // Deliberately a timestamp rather than a boolean - channels.list
      // compares it against the channel's lastMessageAt so a hidden
      // conversation reappears by itself when somebody writes to it again,
      // which needs no write at message time and cannot strand an unanswered
      // reply in a list the recipient can never see.
      await queryInterface.addColumn(
        "channel_memberships",
        "hiddenAt",
        {
          type: Sequelize.DATE,
          allowNull: true,
        },
        { transaction }
      );
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeColumn("channel_memberships", "hiddenAt", {
        transaction,
      });
    });
  },
};
