const shared = {
  use_env_variable: process.env.DATABASE_URL ? "DATABASE_URL" : undefined,
  dialect: "postgres",
  host: process.env.DATABASE_HOST,
  port: process.env.DATABASE_PORT || 5432,
  username: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD || undefined,
  database: process.env.DATABASE_NAME,
};

module.exports = {
  development: shared,
  test: shared,
  // Use with: node_modules/.bin/sequelize <command> --env production-ssl-disabled
  // Needed because sequelize-cli reads its own DB config separately
  // from the app's runtime PGSSLMODE handling, and defaults to
  // requiring SSL under NODE_ENV=production. Without this --env flag,
  // any manual sequelize-cli migration command against a
  // production-mode container (QA or, eventually, prod) will fail
  // with an SSL connection error even though the app itself boots fine.
  "production-ssl-disabled": shared,
  production: {
    ...shared,
    dialectOptions: {
      ssl: {
        rejectUnauthorized: false,
      },
    },
  },
};
