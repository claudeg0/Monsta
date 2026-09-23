"use strict";

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      // A channel has at most one active call. `callId` doubles as the Daily
      // room name - an unguessable uuid per call, not per channel - and all
      // three columns are nulled together when the call ends (via the route
      // or the meeting.ended webhook). Null means idle.
      await queryInterface.addColumn(
        "channels",
        "callId",
        {
          type: Sequelize.UUID,
          allowNull: true,
        },
        { transaction }
      );
      await queryInterface.addColumn(
        "channels",
        "callStartedAt",
        {
          type: Sequelize.DATE,
          allowNull: true,
        },
        { transaction }
      );
      await queryInterface.addColumn(
        "channels",
        "callStartedById",
        {
          type: Sequelize.UUID,
          allowNull: true,
          references: { model: "users", key: "id" },
        },
        { transaction }
      );

      // callId is the webhook's lookup key (room name -> channel), and only
      // one live call may reference a room at a time.
      await queryInterface.addIndex("channels", ["callId"], {
        unique: true,
        transaction,
      });
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.removeIndex("channels", ["callId"], {
        transaction,
      });
      await queryInterface.removeColumn("channels", "callStartedById", {
        transaction,
      });
      await queryInterface.removeColumn("channels", "callStartedAt", {
        transaction,
      });
      await queryInterface.removeColumn("channels", "callId", { transaction });
    });
  },
};
