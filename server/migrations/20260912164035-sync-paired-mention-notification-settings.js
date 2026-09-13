"use strict";

// The notification settings screen exposes a single "Mentioned" toggle and a
// single "Group mentions" toggle, each of which describes itself as covering
// mentions "in a document or comment". Both only ever wrote one of their two
// underlying event types, so the other half was unreachable from the UI and
// could sit at a value the user never chose - silently dropping notifications
// with no way for them to fix it.
//
// Both toggles now write their full pair, and this migration repairs accounts
// that already drifted. Where a pair disagrees the migration turns both on,
// because a divergence can only have come from the bug rather than a
// deliberate choice, and the safe direction is to keep delivering
// notifications rather than silently stop.
//
// Missing keys are compared as `true` to match `subscribedToEventType`, which
// falls back to NotificationEventDefaults - and both mention types default to
// true. A row whose pair already agrees (including one left entirely unset) is
// not touched.

const PAIRS = [
  ["comments.mentioned", "documents.mentioned"],
  ["documents.group_mentioned", "comments.group_mentioned"],
];

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface) {
    for (const [left, right] of PAIRS) {
      const mismatchCondition = `
        COALESCE(("notificationSettings"->>'${left}')::boolean, true)
        IS DISTINCT FROM
        COALESCE(("notificationSettings"->>'${right}')::boolean, true)
      `;

      const [rows] = await queryInterface.sequelize.query(`
        SELECT count(*)::int AS count FROM "users" WHERE ${mismatchCondition};
      `);

      const count = rows[0] ? rows[0].count : 0;
      if (count === 0) {
        continue;
      }

      // oxlint-disable-next-line no-console
      console.log(
        `Syncing ${left} / ${right} for ${count} user(s) with mismatched settings`
      );

      await queryInterface.sequelize.query(`
        UPDATE "users"
        SET "notificationSettings" =
          COALESCE("notificationSettings", '{}'::jsonb)
          || '{"${left}": true, "${right}": true}'::jsonb
        WHERE ${mismatchCondition};
      `);
    }
  },

  async down() {
    // The previous per-user values are not recoverable, so this is a one-way
    // data repair. Leaving both halves of each pair enabled is harmless and
    // remains adjustable from the notification settings screen.
  },
};
