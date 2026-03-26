const path = require("node:path");
const { createClient } = require("@libsql/client");

const ROOT_DIR = path.resolve(__dirname, "..");
const DEFAULT_SOURCE_URL = `file:${path.join(ROOT_DIR, "data", "stock.db").replace(/\\/g, "/")}`;
const SOURCE_DATABASE_URL = process.env.SOURCE_DATABASE_URL || process.env.LOCAL_DATABASE_URL || DEFAULT_SOURCE_URL;
const TARGET_DATABASE_URL = process.env.TARGET_DATABASE_URL || process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || "";
const TARGET_AUTH_TOKEN = process.env.TARGET_AUTH_TOKEN || process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || "";

if (!TARGET_DATABASE_URL) {
  console.error("Defina TARGET_DATABASE_URL ou TURSO_DATABASE_URL antes de rodar a migracao.");
  process.exit(1);
}

const sourceClient = createClient({ url: SOURCE_DATABASE_URL });
const targetClient = createClient({
  url: TARGET_DATABASE_URL,
  authToken: TARGET_AUTH_TOKEN || undefined
});

const TABLES = [
  {
    name: "users",
    selectSql: `
      SELECT id, username, password_hash, role, created_at, updated_at
      FROM users
      ORDER BY created_at ASC
    `,
    insertSql: `
      INSERT OR REPLACE INTO users (
        id, username, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    mapArgs: (row) => [
      row.id,
      row.username,
      row.password_hash,
      row.role,
      row.created_at,
      row.updated_at
    ]
  },
  {
    name: "sessions",
    selectSql: `
      SELECT id, user_id, token_hash, created_at, expires_at
      FROM sessions
      ORDER BY created_at ASC
    `,
    insertSql: `
      INSERT OR REPLACE INTO sessions (
        id, user_id, token_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
    mapArgs: (row) => [
      row.id,
      row.user_id,
      row.token_hash,
      row.created_at,
      row.expires_at
    ]
  },
  {
    name: "materials",
    selectSql: `
      SELECT
        id, name, category, unit, stock, min_stock, cost_price, sale_price, supplier, created_at, updated_at
      FROM materials
      ORDER BY name COLLATE NOCASE ASC
    `,
    insertSql: `
      INSERT OR REPLACE INTO materials (
        id, name, category, unit, stock, min_stock, cost_price, sale_price, supplier, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    mapArgs: (row) => [
      row.id,
      row.name,
      row.category,
      row.unit,
      row.stock,
      row.min_stock,
      row.cost_price,
      row.sale_price,
      row.supplier,
      row.created_at,
      row.updated_at
    ]
  },
  {
    name: "movements",
    selectSql: `
      SELECT
        id, material_id, material_name, type, quantity, unit, unit_price, note, previous_stock, new_stock, created_at
      FROM movements
      ORDER BY created_at ASC
    `,
    insertSql: `
      INSERT OR REPLACE INTO movements (
        id, material_id, material_name, type, quantity, unit, unit_price, note, previous_stock, new_stock, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    mapArgs: (row) => [
      row.id,
      row.material_id,
      row.material_name,
      row.type,
      row.quantity,
      row.unit,
      row.unit_price,
      row.note,
      row.previous_stock,
      row.new_stock,
      row.created_at
    ]
  }
];

void main();

async function main() {
  try {
    await ensureSchema(sourceClient);
    await ensureSchema(targetClient);

    console.log(`Origem: ${SOURCE_DATABASE_URL}`);
    console.log(`Destino: ${TARGET_DATABASE_URL}`);

    await targetClient.executeMultiple(`
      PRAGMA foreign_keys = OFF;
      DELETE FROM sessions;
      DELETE FROM movements;
      DELETE FROM materials;
      DELETE FROM users;
      PRAGMA foreign_keys = ON;
    `);

    for (const table of TABLES) {
      const result = await sourceClient.execute(table.selectSql);
      const rows = result.rows || [];

      if (rows.length) {
        await targetClient.batch(
          rows.map((row) => ({
            sql: table.insertSql,
            args: table.mapArgs(normalizeRow(row))
          })),
          "write"
        );
      }

      console.log(`${table.name}: ${rows.length} registro(s) migrado(s)`);
    }

    console.log("Migracao concluida.");
  } catch (error) {
    console.error("Falha na migracao:", error.message);
    process.exitCode = 1;
  } finally {
    await safeClose(sourceClient);
    await safeClose(targetClient);
  }
}

async function ensureSchema(client) {
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT '',
      unit TEXT NOT NULL DEFAULT 'un',
      stock REAL NOT NULL DEFAULT 0,
      min_stock REAL NOT NULL DEFAULT 0,
      cost_price REAL NOT NULL DEFAULT 0,
      sale_price REAL NOT NULL DEFAULT 0,
      supplier TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS movements (
      id TEXT PRIMARY KEY,
      material_id TEXT NOT NULL,
      material_name TEXT NOT NULL,
      type TEXT NOT NULL,
      quantity REAL NOT NULL,
      unit TEXT NOT NULL,
      unit_price REAL NOT NULL DEFAULT 0,
      note TEXT NOT NULL DEFAULT '',
      previous_stock REAL NOT NULL,
      new_stock REAL NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
  `);
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === "bigint" ? Number(value) : value])
  );
}

async function safeClose(client) {
  if (client && typeof client.close === "function") {
    await client.close();
  }
}
