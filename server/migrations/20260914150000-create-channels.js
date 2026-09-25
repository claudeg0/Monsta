"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.createTable(
        "channels",
        {
          id: {
            type: Sequelize.UUID,
            allowNull: false,
            defaultValue: Sequelize.UUIDV4,
            primaryKey: true,
          },
          teamId: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "teams", key: "id" },
            onDelete: "CASCADE",
          },
          type: {
            type: Sequelize.ENUM("dm", "group"),
            allowNull: false,
          },
          name: {
            type: Sequelize.STRING,
            allowNull: true,
          },
          createdById: {
            type: Sequelize.UUID,
            allowNull: false,
            references: { model: "users", key: "id" },
          },
          lastMessageAt: {
            type: Sequelize.DATE,
            allowNull: true,
          },
          archivedAt: {
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

      await queryInterface.addIndex("channels", ["teamId"], { transaction });
      await queryInterface.addIndex("channels", ["teamId", "lastMessageAt"], {
        transaction,
      });
    });
  },

  async down(queryInterface) {
    return queryInterface.sequelize.transaction(async (transaction) => {
      await queryInterface.dropTable("channels", { transaction });
      // Explicitly drop the ENUM type Postgres creates for `type`, otherwise
      // it lingers and collides if this migration is ever re-run.
      await queryInterface.sequelize.query(
        'DROP TYPE IF EXISTS "enum_channels_type";',
        { transaction }
      );
    });
  },
};
