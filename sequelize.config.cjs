require('dotenv').config();

const common = {
  username: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'root',
  database: process.env.DB_NAME || 'chat_db',
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 3306),
  dialect: 'mysql',
  define: {
    underscored: true,
    charset: 'utf8mb4',
  },
};

module.exports = {
  development: common,
  test: common,
  production: common,
};
