// db.js
const mysql = require('mysql2/promise');

const {
  DB_HOST = '127.0.0.1',
  DB_USER = 'root',
  DB_PASSWORD = '',
  DB_NAME = 'metalurgicas el imperio',
  DB_PORT = 3306
} = process.env;

let pool;

async function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: DB_HOST,
      user: DB_USER,
      password: DB_PASSWORD,
      database: DB_NAME, // incluye el espacio exactamente
      port: Number(DB_PORT),
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      dateStrings: true // fechas como 'YYYY-MM-DD'
    });
  }
  return pool;
}

module.exports = { getPool };
