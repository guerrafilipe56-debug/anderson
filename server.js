const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");
const { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { URL } = require("node:url");
const { createClient } = require("@libsql/client");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const LOCAL_DATABASE_PATH = path.join(DATA_DIR, "stock.db");
const PORT = Number(process.env.PORT) || 3000;
const SESSION_COOKIE_NAME = "estoque_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;
const REMOTE_DATABASE_URL = process.env.TURSO_DATABASE_URL || process.env.LIBSQL_URL || "";
const REMOTE_DATABASE_TOKEN = process.env.TURSO_AUTH_TOKEN || process.env.LIBSQL_AUTH_TOKEN || "";

fs.mkdirSync(DATA_DIR, { recursive: true });

const runtimeConfig = createRuntimeConfig();
const db = createClient(runtimeConfig.client);
let databaseReadyPromise = null;

if (require.main === module) {
  const server = createServer((request, response) => {
    void handleNodeRequest(request, response);
  });

  server.listen(PORT, () => {
    console.log(`Servidor de estoque rodando em http://127.0.0.1:${PORT}`);
    console.log(`Banco ativo: ${runtimeConfig.storageMode}`);
    console.log(`Conexao: ${runtimeConfig.displayUrl}`);
  });
}

module.exports = {
  handleNodeRequest,
  handleServerlessRequest,
  ensureDatabaseReady
};

async function handleNodeRequest(request, response) {
  await handleIncomingRequest(request, response, { apiOnly: false });
}

async function handleServerlessRequest(request, response) {
  const routeOverride = normalizeRouteOverride(request.query?.route);
  await handleIncomingRequest(request, response, {
    apiOnly: true,
    routeOverride
  });
}

async function handleIncomingRequest(request, response, options = {}) {
  setCorsHeaders(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    await ensureDatabaseReady();
    await cleanupExpiredSessions();

    const url = buildRequestUrl(request, options.routeOverride);

    if (url.pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, url);
      return;
    }

    if (options.apiOnly) {
      sendJson(response, 404, { error: "Rota nao encontrada." });
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Metodo nao permitido." });
      return;
    }

    serveStaticFile(response, url.pathname, request.method === "HEAD");
  } catch (error) {
    if (!error.status || error.status >= 500) {
      console.error(error);
    }
    sendJson(response, error.status || 500, {
      error: error.message || "Erro interno no servidor."
    });
  }
}

async function handleApiRequest(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    const setupRequired = await getUserCount() === 0;
    const session = await getAuthenticatedSession(request);

    sendJson(response, 200, {
      setupRequired,
      authenticated: Boolean(session),
      user: session ? sanitizeUser(session.user) : null
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/setup") {
    if (await getUserCount() > 0) {
      throw createHttpError(409, "O administrador inicial ja foi criado.");
    }

    const body = await readJsonBody(request);
    const user = await createUser(body, { forceRole: "admin" });
    const session = await createSession(user.id);

    setSessionCookie(response, request, session.token);
    sendJson(response, 201, {
      setupRequired: false,
      authenticated: true,
      user: sanitizeUser(user)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    const user = await authenticateUser(body);
    const session = await createSession(user.id);

    setSessionCookie(response, request, session.token);
    sendJson(response, 200, {
      setupRequired: false,
      authenticated: true,
      user: sanitizeUser(user)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/register") {
    if (await getUserCount() === 0) {
      throw createHttpError(409, "Crie o administrador inicial antes de liberar cadastro livre.");
    }

    const body = await readJsonBody(request);
    const user = await createUser(body, { forceRole: "operator" });
    const session = await createSession(user.id);

    setSessionCookie(response, request, session.token);
    sendJson(response, 201, {
      setupRequired: false,
      authenticated: true,
      user: sanitizeUser(user)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = getSessionTokenFromRequest(request);

    if (token) {
      await deleteSessionByToken(token);
    }

    clearSessionCookie(response, request);
    sendJson(response, 200, { authenticated: false });
    return;
  }

  const session = await requireAuthenticatedSession(request);

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(response, 200, {
      storageMode: runtimeConfig.storageMode,
      materials: await listMaterials(),
      movements: await listMovements(),
      users: session.user.role === "admin" ? await listUsers() : [],
      user: sanitizeUser(session.user)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/users") {
    requireAdminUser(session.user);
    sendJson(response, 200, { users: await listUsers() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/users") {
    requireAdminUser(session.user);
    const body = await readJsonBody(request);
    const user = await createUser(body, { allowRole: true });
    sendJson(response, 201, { user: sanitizeUser(user) });
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/users/")) {
    requireAdminUser(session.user);
    const userId = decodeURIComponent(url.pathname.replace("/api/users/", ""));
    await deleteUserAccount(userId, session.user.id);
    sendJson(response, 200, { deleted: true });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/materials") {
    sendJson(response, 200, { materials: await listMaterials() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/movements") {
    sendJson(response, 200, { movements: await listMovements() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/import") {
    const body = await readJsonBody(request);
    await importLegacyData(body);
    sendJson(response, 200, {
      imported: true,
      materials: await listMaterials(),
      movements: await listMovements()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/materials") {
    const body = await readJsonBody(request);
    const material = await createMaterial(body);
    sendJson(response, 201, { material });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/movements") {
    const body = await readJsonBody(request);
    const movementResult = await createMovement(body);
    sendJson(response, 201, movementResult);
    return;
  }

  if (request.method === "PUT" && url.pathname.startsWith("/api/materials/")) {
    const materialId = decodeURIComponent(url.pathname.replace("/api/materials/", ""));
    const body = await readJsonBody(request);
    const material = await updateMaterial(materialId, body);
    sendJson(response, 200, { material });
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/materials/")) {
    const materialId = decodeURIComponent(url.pathname.replace("/api/materials/", ""));
    await deleteMaterial(materialId);
    sendJson(response, 200, { deleted: true });
    return;
  }

  sendJson(response, 404, { error: "Rota nao encontrada." });
}

function createRuntimeConfig() {
  if (REMOTE_DATABASE_URL) {
    const isLocalFileDatabase = REMOTE_DATABASE_URL.startsWith("file:");

    return {
      storageMode: isLocalFileDatabase ? "sqlite-local" : "libsql-remote",
      displayUrl: REMOTE_DATABASE_URL,
      client: {
        url: REMOTE_DATABASE_URL,
        authToken: REMOTE_DATABASE_TOKEN || undefined
      }
    };
  }

  if (process.env.VERCEL) {
    throw new Error("Configure TURSO_DATABASE_URL e TURSO_AUTH_TOKEN na Vercel antes de publicar.");
  }

  return {
    storageMode: "sqlite-local",
    displayUrl: LOCAL_DATABASE_PATH,
    client: {
      url: `file:${LOCAL_DATABASE_PATH.replace(/\\/g, "/")}`
    }
  };
}

async function ensureDatabaseReady() {
  if (!databaseReadyPromise) {
    databaseReadyPromise = initializeDatabase().catch((error) => {
      databaseReadyPromise = null;
      throw error;
    });
  }

  await databaseReadyPromise;
}

async function initializeDatabase() {
  await db.executeMultiple(`
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

function setCorsHeaders(request, response) {
  const origin = getHeaderValue(request.headers.origin);

  response.setHeader("Access-Control-Allow-Origin", origin || "*");
  response.setHeader("Access-Control-Allow-Headers", "Content-Type");
  response.setHeader("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
  response.setHeader("Access-Control-Allow-Credentials", "true");
  response.setHeader("Vary", "Origin");
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(payload));
}

function serveStaticFile(response, pathname, headOnly = false) {
  const requestedPath = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const filePath = path.resolve(ROOT_DIR, requestedPath);

  if (!filePath.startsWith(ROOT_DIR) || filePath.startsWith(DATA_DIR)) {
    throw createHttpError(403, "Acesso negado.");
  }

  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    throw createHttpError(404, "Arquivo nao encontrado.");
  }

  response.writeHead(200, {
    "Content-Type": getContentType(filePath)
  });

  if (headOnly) {
    response.end();
    return;
  }

  response.end(fs.readFileSync(filePath));
}

function getContentType(filePath) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".html") {
    return "text/html; charset=utf-8";
  }

  if (extension === ".js") {
    return "application/javascript; charset=utf-8";
  }

  if (extension === ".css") {
    return "text/css; charset=utf-8";
  }

  if (extension === ".png") {
    return "image/png";
  }

  return "application/octet-stream";
}

async function readJsonBody(request) {
  const chunks = [];

  for await (const chunk of request) {
    chunks.push(chunk);
  }

  if (!chunks.length) {
    return {};
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf-8"));
  } catch (error) {
    throw createHttpError(400, "JSON invalido.");
  }
}

async function listMaterials() {
  return queryAll(`
    SELECT
      id,
      name,
      category,
      unit,
      stock,
      min_stock AS minStock,
      cost_price AS costPrice,
      sale_price AS salePrice,
      supplier,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM materials
    ORDER BY name COLLATE NOCASE ASC
  `);
}

async function listMovements() {
  return queryAll(`
    SELECT
      id,
      material_id AS materialId,
      material_name AS materialName,
      type,
      quantity,
      unit,
      unit_price AS unitPrice,
      note,
      previous_stock AS previousStock,
      new_stock AS newStock,
      created_at AS createdAt
    FROM movements
    ORDER BY created_at DESC
  `);
}

async function listUsers() {
  return queryAll(`
    SELECT
      id,
      username,
      role,
      created_at AS createdAt,
      updated_at AS updatedAt
    FROM users
    ORDER BY lower(username) ASC
  `);
}

async function createMaterial(input) {
  const material = normalizeMaterialInput(input);
  const timestamp = new Date().toISOString();
  const createdMaterial = {
    id: randomUUID(),
    name: material.name,
    category: material.category,
    unit: material.unit,
    stock: material.stock,
    minStock: material.minStock,
    costPrice: material.costPrice,
    salePrice: material.salePrice,
    supplier: material.supplier,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await executeSql(
    `
      INSERT INTO materials (
        id, name, category, unit, stock, min_stock, cost_price, sale_price, supplier, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      createdMaterial.id,
      createdMaterial.name,
      createdMaterial.category,
      createdMaterial.unit,
      createdMaterial.stock,
      createdMaterial.minStock,
      createdMaterial.costPrice,
      createdMaterial.salePrice,
      createdMaterial.supplier,
      createdMaterial.createdAt,
      createdMaterial.updatedAt
    ]
  );

  return createdMaterial;
}

async function updateMaterial(materialId, input) {
  const existingMaterial = await getMaterialById(materialId);

  if (!existingMaterial) {
    throw createHttpError(404, "Material nao encontrado.");
  }

  const material = normalizeMaterialInput(input);
  const updatedMaterial = {
    ...existingMaterial,
    name: material.name,
    category: material.category,
    unit: material.unit,
    minStock: material.minStock,
    costPrice: material.costPrice,
    salePrice: material.salePrice,
    supplier: material.supplier,
    updatedAt: new Date().toISOString()
  };

  await executeSql(
    `
      UPDATE materials
      SET
        name = ?,
        category = ?,
        unit = ?,
        min_stock = ?,
        cost_price = ?,
        sale_price = ?,
        supplier = ?,
        updated_at = ?
      WHERE id = ?
    `,
    [
      updatedMaterial.name,
      updatedMaterial.category,
      updatedMaterial.unit,
      updatedMaterial.minStock,
      updatedMaterial.costPrice,
      updatedMaterial.salePrice,
      updatedMaterial.supplier,
      updatedMaterial.updatedAt,
      materialId
    ]
  );

  return updatedMaterial;
}

async function deleteMaterial(materialId) {
  const result = await executeSql("DELETE FROM materials WHERE id = ?", [materialId]);

  if (!result.rowsAffected) {
    throw createHttpError(404, "Material nao encontrado.");
  }
}

async function createMovement(input) {
  const movementInput = normalizeMovementInput(input);
  const material = await getMaterialById(movementInput.materialId);

  if (!material) {
    throw createHttpError(404, "Material nao encontrado.");
  }

  const previousStock = material.stock;
  let newStock = previousStock;
  let newCostPrice = material.costPrice;

  if (movementInput.type === "entry") {
    newStock = previousStock + movementInput.quantity;

    if (movementInput.unitPrice > 0) {
      newCostPrice = movementInput.unitPrice;
    }
  }

  if (movementInput.type === "exit") {
    if (movementInput.quantity > previousStock) {
      throw createHttpError(400, "A quantidade de saida nao pode ser maior que o estoque atual.");
    }

    newStock = previousStock - movementInput.quantity;
  }

  if (movementInput.type === "adjustment") {
    newStock = movementInput.quantity;
  }

  const movement = {
    id: randomUUID(),
    materialId: material.id,
    materialName: material.name,
    type: movementInput.type,
    quantity: movementInput.quantity,
    unit: material.unit,
    unitPrice: movementInput.unitPrice,
    note: movementInput.note,
    previousStock,
    newStock,
    createdAt: new Date().toISOString()
  };

  await executeBatch(
    [
      {
        sql: `
          UPDATE materials
          SET stock = ?, cost_price = ?, updated_at = ?
          WHERE id = ?
        `,
        args: [newStock, newCostPrice, movement.createdAt, material.id]
      },
      {
        sql: `
          INSERT INTO movements (
            id, material_id, material_name, type, quantity, unit, unit_price, note, previous_stock, new_stock, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
          movement.id,
          movement.materialId,
          movement.materialName,
          movement.type,
          movement.quantity,
          movement.unit,
          movement.unitPrice,
          movement.note,
          movement.previousStock,
          movement.newStock,
          movement.createdAt
        ]
      }
    ],
    "write"
  );

  return {
    movement,
    material: await getMaterialById(material.id)
  };
}

async function importLegacyData(payload) {
  const materials = Array.isArray(payload?.materials) ? payload.materials : [];
  const movements = Array.isArray(payload?.movements) ? payload.movements : [];
  const materialsCount = await queryScalar("SELECT COUNT(*) AS total FROM materials");
  const movementsCount = await queryScalar("SELECT COUNT(*) AS total FROM movements");

  if (materialsCount > 0 || movementsCount > 0 || (!materials.length && !movements.length)) {
    return;
  }

  const statements = [];

  materials.forEach((material) => {
    const normalizedMaterial = normalizeImportedMaterial(material);
    statements.push({
      sql: `
        INSERT OR REPLACE INTO materials (
          id, name, category, unit, stock, min_stock, cost_price, sale_price, supplier, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        normalizedMaterial.id,
        normalizedMaterial.name,
        normalizedMaterial.category,
        normalizedMaterial.unit,
        normalizedMaterial.stock,
        normalizedMaterial.minStock,
        normalizedMaterial.costPrice,
        normalizedMaterial.salePrice,
        normalizedMaterial.supplier,
        normalizedMaterial.createdAt,
        normalizedMaterial.updatedAt
      ]
    });
  });

  movements.forEach((movement) => {
    const normalizedMovement = normalizeImportedMovement(movement);
    statements.push({
      sql: `
        INSERT OR REPLACE INTO movements (
          id, material_id, material_name, type, quantity, unit, unit_price, note, previous_stock, new_stock, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      args: [
        normalizedMovement.id,
        normalizedMovement.materialId,
        normalizedMovement.materialName,
        normalizedMovement.type,
        normalizedMovement.quantity,
        normalizedMovement.unit,
        normalizedMovement.unitPrice,
        normalizedMovement.note,
        normalizedMovement.previousStock,
        normalizedMovement.newStock,
        normalizedMovement.createdAt
      ]
    });
  });

  if (statements.length) {
    await executeBatch(statements, "write");
  }
}

async function createUser(input, options = {}) {
  const username = String(input?.username || "").trim();
  const password = String(input?.password || "");
  const role = normalizeUserRole(input?.role, options);

  if (username.length < 3) {
    throw createHttpError(400, "Use um usuario com pelo menos 3 caracteres.");
  }

  if (password.length < 6) {
    throw createHttpError(400, "Use uma senha com pelo menos 6 caracteres.");
  }

  if (await getUserByUsername(username)) {
    throw createHttpError(409, "Esse usuario ja existe.");
  }

  const timestamp = new Date().toISOString();
  const user = {
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password),
    role,
    createdAt: timestamp,
    updatedAt: timestamp
  };

  await executeSql(
    `
      INSERT INTO users (
        id, username, password_hash, role, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `,
    [
      user.id,
      user.username,
      user.passwordHash,
      user.role,
      user.createdAt,
      user.updatedAt
    ]
  );

  return user;
}

async function authenticateUser(input) {
  const username = String(input?.username || "").trim();
  const password = String(input?.password || "");
  const user = await getUserByUsername(username);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw createHttpError(401, "Usuario ou senha invalidos.");
  }

  return user;
}

async function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const session = {
    id: randomUUID(),
    userId,
    token,
    tokenHash: hashSessionToken(token),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString()
  };

  await executeSql(
    `
      INSERT INTO sessions (
        id, user_id, token_hash, created_at, expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `,
    [session.id, session.userId, session.tokenHash, session.createdAt, session.expiresAt]
  );

  return session;
}

async function requireAuthenticatedSession(request) {
  const session = await getAuthenticatedSession(request);

  if (!session) {
    throw createHttpError(401, "Sua sessao expirou. Entre novamente.");
  }

  return session;
}

async function getAuthenticatedSession(request) {
  const token = getSessionTokenFromRequest(request);

  if (!token) {
    return null;
  }

  const row = await queryOne(
    `
      SELECT
        sessions.id AS sessionId,
        sessions.user_id AS userId,
        sessions.expires_at AS expiresAt,
        users.id AS id,
        users.username AS username,
        users.role AS role,
        users.created_at AS createdAt,
        users.updated_at AS updatedAt
      FROM sessions
      JOIN users ON users.id = sessions.user_id
      WHERE sessions.token_hash = ?
        AND sessions.expires_at > ?
      LIMIT 1
    `,
    [hashSessionToken(token), new Date().toISOString()]
  );

  if (!row) {
    return null;
  }

  return {
    id: row.sessionId,
    userId: row.userId,
    expiresAt: row.expiresAt,
    user: {
      id: row.id,
      username: row.username,
      role: row.role,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt
    }
  };
}

function getSessionTokenFromRequest(request) {
  const cookies = parseCookies(getHeaderValue(request.headers.cookie) || "");
  return cookies[SESSION_COOKIE_NAME] || "";
}

function setSessionCookie(response, request, token) {
  response.setHeader("Set-Cookie", buildSessionCookieValue(request, `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}`));
}

function clearSessionCookie(response, request) {
  response.setHeader("Set-Cookie", buildSessionCookieValue(request, `${SESSION_COOKIE_NAME}=; Max-Age=0`));
}

async function deleteSessionByToken(token) {
  if (!token) {
    return;
  }

  await executeSql("DELETE FROM sessions WHERE token_hash = ?", [hashSessionToken(token)]);
}

async function cleanupExpiredSessions() {
  await executeSql("DELETE FROM sessions WHERE expires_at <= ?", [new Date().toISOString()]);
}

async function getMaterialById(materialId) {
  return queryOne(
    `
      SELECT
        id,
        name,
        category,
        unit,
        stock,
        min_stock AS minStock,
        cost_price AS costPrice,
        sale_price AS salePrice,
        supplier,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM materials
      WHERE id = ?
    `,
    [materialId]
  );
}

async function getUserByUsername(username) {
  return queryOne(
    `
      SELECT
        id,
        username,
        password_hash AS passwordHash,
        role,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM users
      WHERE lower(username) = lower(?)
      LIMIT 1
    `,
    [username]
  );
}

async function getUserById(userId) {
  return queryOne(
    `
      SELECT
        id,
        username,
        password_hash AS passwordHash,
        role,
        created_at AS createdAt,
        updated_at AS updatedAt
      FROM users
      WHERE id = ?
      LIMIT 1
    `,
    [userId]
  );
}

async function getUserCount() {
  return queryScalar("SELECT COUNT(*) AS total FROM users");
}

async function countUsersByRole(role) {
  return queryScalar("SELECT COUNT(*) AS total FROM users WHERE role = ?", [role]);
}

function sanitizeUser(user) {
  return {
    id: user.id,
    username: user.username,
    role: user.role
  };
}

function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const hash = scryptSync(password, salt, 64).toString("hex");
  return `scrypt$${salt}$${hash}`;
}

function requireAdminUser(user) {
  if (user?.role !== "admin") {
    throw createHttpError(403, "Somente administrador pode gerenciar contas.");
  }
}

function verifyPassword(password, storedHash) {
  const [algorithm, salt, hash] = String(storedHash || "").split("$");

  if (algorithm !== "scrypt" || !salt || !hash) {
    return false;
  }

  const expectedHash = Buffer.from(hash, "hex");
  const actualHash = scryptSync(password, salt, expectedHash.length);

  return timingSafeEqual(expectedHash, actualHash);
}

function hashSessionToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function parseCookies(cookieHeader) {
  return cookieHeader
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean)
    .reduce((cookies, part) => {
      const separatorIndex = part.indexOf("=");

      if (separatorIndex === -1) {
        return cookies;
      }

      const key = part.slice(0, separatorIndex).trim();
      const value = decodeURIComponent(part.slice(separatorIndex + 1).trim());

      cookies[key] = value;
      return cookies;
    }, {});
}

function normalizeMaterialInput(input) {
  const name = String(input?.name || "").trim();

  if (!name) {
    throw createHttpError(400, "Informe o nome do material.");
  }

  return {
    name,
    category: String(input?.category || "").trim(),
    unit: String(input?.unit || "un").trim() || "un",
    stock: Math.max(0, toNumber(input?.stock)),
    minStock: Math.max(0, toNumber(input?.minStock)),
    costPrice: Math.max(0, toNumber(input?.costPrice)),
    salePrice: Math.max(0, toNumber(input?.salePrice)),
    supplier: String(input?.supplier || "").trim()
  };
}

function normalizeMovementInput(input) {
  const type = String(input?.type || "entry").trim();
  const quantity = Math.max(0, toNumber(input?.quantity));
  const materialId = String(input?.materialId || "").trim();

  if (!materialId) {
    throw createHttpError(400, "Selecione um material valido.");
  }

  if (!["entry", "exit", "adjustment"].includes(type)) {
    throw createHttpError(400, "Tipo de movimentacao invalido.");
  }

  if (quantity < 0 || (type !== "adjustment" && quantity <= 0)) {
    throw createHttpError(400, "Informe uma quantidade valida para a movimentacao.");
  }

  return {
    materialId,
    type,
    quantity,
    unitPrice: Math.max(0, toNumber(input?.unitPrice)),
    note: String(input?.note || "").trim()
  };
}

function normalizeImportedMaterial(material) {
  const normalized = normalizeMaterialInput(material);

  return {
    id: String(material?.id || randomUUID()),
    name: normalized.name,
    category: normalized.category,
    unit: normalized.unit,
    stock: normalized.stock,
    minStock: normalized.minStock,
    costPrice: normalized.costPrice,
    salePrice: normalized.salePrice,
    supplier: normalized.supplier,
    createdAt: String(material?.createdAt || new Date().toISOString()),
    updatedAt: String(material?.updatedAt || new Date().toISOString())
  };
}

function normalizeImportedMovement(movement) {
  const normalized = normalizeMovementInput(movement);

  return {
    id: String(movement?.id || randomUUID()),
    materialId: normalized.materialId,
    materialName: String(movement?.materialName || "").trim(),
    type: normalized.type,
    quantity: normalized.quantity,
    unit: String(movement?.unit || "un").trim() || "un",
    unitPrice: normalized.unitPrice,
    note: normalized.note,
    previousStock: toNumber(movement?.previousStock),
    newStock: toNumber(movement?.newStock),
    createdAt: String(movement?.createdAt || new Date().toISOString())
  };
}

function toNumber(value) {
  if (value === null || value === undefined || value === "") {
    return 0;
  }

  const numericValue = Number(String(value).replace(",", "."));
  return Number.isFinite(numericValue) ? numericValue : 0;
}

function createHttpError(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function normalizeUserRole(roleInput, options = {}) {
  if (options.forceRole) {
    return options.forceRole;
  }

  const normalizedRole = String(roleInput || "operator").trim().toLowerCase();

  if (!options.allowRole) {
    return "admin";
  }

  if (!["admin", "operator"].includes(normalizedRole)) {
    throw createHttpError(400, "Nivel de usuario invalido.");
  }

  return normalizedRole;
}

function buildRequestUrl(request, routeOverride) {
  const host = getHeaderValue(request.headers["x-forwarded-host"]) || getHeaderValue(request.headers.host) || "127.0.0.1";
  const protocol = getHeaderValue(request.headers["x-forwarded-proto"]) || (process.env.VERCEL ? "https" : "http");
  const pathname = routeOverride ? `/api/${routeOverride}` : request.url;

  return new URL(pathname, `${protocol}://${host}`);
}

function normalizeRouteOverride(route) {
  if (Array.isArray(route)) {
    return route.filter(Boolean).join("/");
  }

  return String(route || "").trim().replace(/^\/+/, "");
}

function buildSessionCookieValue(request, baseValue) {
  const secure = isSecureRequest(request) ? "; Secure" : "";
  return `${baseValue}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

function isSecureRequest(request) {
  const forwardedProto = getHeaderValue(request.headers["x-forwarded-proto"]);
  return forwardedProto === "https" || Boolean(process.env.VERCEL);
}

function getHeaderValue(header) {
  if (Array.isArray(header)) {
    return header[0] || "";
  }

  return String(header || "");
}

async function queryAll(sql, args = []) {
  const result = await executeSql(sql, args);
  return result.rows.map((row) => normalizeRow(row));
}

async function queryOne(sql, args = []) {
  const rows = await queryAll(sql, args);
  return rows[0] || null;
}

async function queryScalar(sql, args = []) {
  const row = await queryOne(sql, args);

  if (!row) {
    return 0;
  }

  const firstKey = Object.keys(row)[0];
  return toNumber(row[firstKey]);
}

async function executeSql(sql, args = []) {
  await ensureDatabaseReady();
  return db.execute({
    sql,
    args
  });
}

async function executeBatch(statements, mode = "write") {
  await ensureDatabaseReady();
  return db.batch(
    statements.map((statement) => ({
      sql: statement.sql,
      args: statement.args || []
    })),
    mode
  );
}

function normalizeRow(row) {
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, normalizeDatabaseValue(value)])
  );
}

function normalizeDatabaseValue(value) {
  if (typeof value === "bigint") {
    const numericValue = Number(value);
    return Number.isSafeInteger(numericValue) ? numericValue : value.toString();
  }

  return value;
}

async function deleteUserAccount(userId, actingUserId) {
  const user = await getUserById(userId);

  if (!user) {
    throw createHttpError(404, "Usuario nao encontrado.");
  }

  if (user.id === actingUserId) {
    throw createHttpError(400, "Voce nao pode excluir a propria conta enquanto estiver logado.");
  }

  if (user.role === "admin" && await countUsersByRole("admin") <= 1) {
    throw createHttpError(400, "Mantenha pelo menos um administrador ativo.");
  }

  await executeSql("DELETE FROM users WHERE id = ?", [userId]);
}
