const fs = require("node:fs");
const path = require("node:path");
const { createServer } = require("node:http");
const { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } = require("node:crypto");
const { URL } = require("node:url");
const { DatabaseSync } = require("node:sqlite");

const ROOT_DIR = __dirname;
const DATA_DIR = path.join(ROOT_DIR, "data");
const DATABASE_PATH = path.join(DATA_DIR, "stock.db");
const PORT = Number(process.env.PORT) || 3000;
const SESSION_COOKIE_NAME = "estoque_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new DatabaseSync(DATABASE_PATH);

db.exec(`
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

const insertMaterialStatement = db.prepare(`
  INSERT INTO materials (
    id, name, category, unit, stock, min_stock, cost_price, sale_price, supplier, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertMovementStatement = db.prepare(`
  INSERT INTO movements (
    id, material_id, material_name, type, quantity, unit, unit_price, note, previous_stock, new_stock, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertImportedMaterialStatement = db.prepare(`
  INSERT OR REPLACE INTO materials (
    id, name, category, unit, stock, min_stock, cost_price, sale_price, supplier, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const upsertImportedMovementStatement = db.prepare(`
  INSERT OR REPLACE INTO movements (
    id, material_id, material_name, type, quantity, unit, unit_price, note, previous_stock, new_stock, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const insertUserStatement = db.prepare(`
  INSERT INTO users (
    id, username, password_hash, role, created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?)
`);

const insertSessionStatement = db.prepare(`
  INSERT INTO sessions (
    id, user_id, token_hash, created_at, expires_at
  ) VALUES (?, ?, ?, ?, ?)
`);

const server = createServer(async (request, response) => {
  setCorsHeaders(request, response);

  if (request.method === "OPTIONS") {
    response.writeHead(204);
    response.end();
    return;
  }

  try {
    cleanupExpiredSessions();

    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);

    if (url.pathname.startsWith("/api/")) {
      await handleApiRequest(request, response, url);
      return;
    }

    if (request.method !== "GET" && request.method !== "HEAD") {
      sendJson(response, 405, { error: "Metodo nao permitido." });
      return;
    }

    serveStaticFile(response, url.pathname);
  } catch (error) {
    console.error(error);
    sendJson(response, error.status || 500, {
      error: error.message || "Erro interno no servidor."
    });
  }
});

server.listen(PORT, () => {
  console.log(`Servidor de estoque rodando em http://127.0.0.1:${PORT}`);
  console.log(`Banco SQLite em ${DATABASE_PATH}`);
});

async function handleApiRequest(request, response, url) {
  if (request.method === "GET" && url.pathname === "/api/auth/status") {
    const setupRequired = getUserCount() === 0;
    const session = getAuthenticatedSession(request);

    sendJson(response, 200, {
      setupRequired,
      authenticated: Boolean(session),
      user: session ? sanitizeUser(session.user) : null
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/setup") {
    if (getUserCount() > 0) {
      throw createHttpError(409, "O administrador inicial ja foi criado.");
    }

    const body = await readJsonBody(request);
    const user = createUser(body);
    const session = createSession(user.id);

    setSessionCookie(response, session.token);
    sendJson(response, 201, {
      setupRequired: false,
      authenticated: true,
      user: sanitizeUser(user)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/login") {
    const body = await readJsonBody(request);
    const user = authenticateUser(body);
    const session = createSession(user.id);

    setSessionCookie(response, session.token);
    sendJson(response, 200, {
      setupRequired: false,
      authenticated: true,
      user: sanitizeUser(user)
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/auth/logout") {
    const token = getSessionTokenFromRequest(request);

    if (token) {
      deleteSessionByToken(token);
    }

    clearSessionCookie(response);
    sendJson(response, 200, { authenticated: false });
    return;
  }

  const session = requireAuthenticatedSession(request);

  if (request.method === "GET" && url.pathname === "/api/bootstrap") {
    sendJson(response, 200, {
      storageMode: "sqlite",
      materials: listMaterials(),
      movements: listMovements(),
      user: sanitizeUser(session.user)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/materials") {
    sendJson(response, 200, { materials: listMaterials() });
    return;
  }

  if (request.method === "GET" && url.pathname === "/api/movements") {
    sendJson(response, 200, { movements: listMovements() });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/import") {
    const body = await readJsonBody(request);
    importLegacyData(body);
    sendJson(response, 200, {
      imported: true,
      materials: listMaterials(),
      movements: listMovements()
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/materials") {
    const body = await readJsonBody(request);
    const material = createMaterial(body);
    sendJson(response, 201, { material });
    return;
  }

  if (request.method === "POST" && url.pathname === "/api/movements") {
    const body = await readJsonBody(request);
    const movementResult = createMovement(body);
    sendJson(response, 201, movementResult);
    return;
  }

  if (request.method === "PUT" && url.pathname.startsWith("/api/materials/")) {
    const materialId = decodeURIComponent(url.pathname.replace("/api/materials/", ""));
    const body = await readJsonBody(request);
    const material = updateMaterial(materialId, body);
    sendJson(response, 200, { material });
    return;
  }

  if (request.method === "DELETE" && url.pathname.startsWith("/api/materials/")) {
    const materialId = decodeURIComponent(url.pathname.replace("/api/materials/", ""));
    deleteMaterial(materialId);
    sendJson(response, 200, { deleted: true });
    return;
  }

  sendJson(response, 404, { error: "Rota nao encontrada." });
}

function setCorsHeaders(request, response) {
  const origin = request.headers.origin;

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

function serveStaticFile(response, pathname) {
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

function listMaterials() {
  return db.prepare(`
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
  `).all();
}

function listMovements() {
  return db.prepare(`
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
  `).all();
}

function createMaterial(input) {
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

  insertMaterialStatement.run(
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
  );

  return createdMaterial;
}

function updateMaterial(materialId, input) {
  const existingMaterial = getMaterialById(materialId);

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

  db.prepare(`
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
  `).run(
    updatedMaterial.name,
    updatedMaterial.category,
    updatedMaterial.unit,
    updatedMaterial.minStock,
    updatedMaterial.costPrice,
    updatedMaterial.salePrice,
    updatedMaterial.supplier,
    updatedMaterial.updatedAt,
    materialId
  );

  return updatedMaterial;
}

function deleteMaterial(materialId) {
  const result = db.prepare("DELETE FROM materials WHERE id = ?").run(materialId);

  if (!result.changes) {
    throw createHttpError(404, "Material nao encontrado.");
  }
}

function createMovement(input) {
  const movementInput = normalizeMovementInput(input);
  const material = getMaterialById(movementInput.materialId);

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

  runInTransaction(() => {
    db.prepare(`
      UPDATE materials
      SET stock = ?, cost_price = ?, updated_at = ?
      WHERE id = ?
    `).run(newStock, newCostPrice, movement.createdAt, material.id);

    insertMovementStatement.run(
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
    );
  });

  return {
    movement,
    material: getMaterialById(material.id)
  };
}

function importLegacyData(payload) {
  const materials = Array.isArray(payload?.materials) ? payload.materials : [];
  const movements = Array.isArray(payload?.movements) ? payload.movements : [];
  const hasMaterials = db.prepare("SELECT COUNT(*) AS total FROM materials").get().total > 0;
  const hasMovements = db.prepare("SELECT COUNT(*) AS total FROM movements").get().total > 0;

  if (hasMaterials || hasMovements || (!materials.length && !movements.length)) {
    return;
  }

  runInTransaction(() => {
    materials.forEach((material) => {
      const normalizedMaterial = normalizeImportedMaterial(material);

      upsertImportedMaterialStatement.run(
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
      );
    });

    movements.forEach((movement) => {
      const normalizedMovement = normalizeImportedMovement(movement);

      upsertImportedMovementStatement.run(
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
      );
    });
  });
}

function createUser(input) {
  const username = String(input?.username || "").trim();
  const password = String(input?.password || "");

  if (username.length < 3) {
    throw createHttpError(400, "Use um usuario com pelo menos 3 caracteres.");
  }

  if (password.length < 6) {
    throw createHttpError(400, "Use uma senha com pelo menos 6 caracteres.");
  }

  if (getUserByUsername(username)) {
    throw createHttpError(409, "Esse usuario ja existe.");
  }

  const timestamp = new Date().toISOString();
  const user = {
    id: randomUUID(),
    username,
    passwordHash: hashPassword(password),
    role: "admin",
    createdAt: timestamp,
    updatedAt: timestamp
  };

  insertUserStatement.run(
    user.id,
    user.username,
    user.passwordHash,
    user.role,
    user.createdAt,
    user.updatedAt
  );

  return user;
}

function authenticateUser(input) {
  const username = String(input?.username || "").trim();
  const password = String(input?.password || "");
  const user = getUserByUsername(username);

  if (!user || !verifyPassword(password, user.passwordHash)) {
    throw createHttpError(401, "Usuario ou senha invalidos.");
  }

  return user;
}

function createSession(userId) {
  const token = randomBytes(32).toString("hex");
  const session = {
    id: randomUUID(),
    userId,
    token,
    tokenHash: hashSessionToken(token),
    createdAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + SESSION_MAX_AGE_SECONDS * 1000).toISOString()
  };

  insertSessionStatement.run(
    session.id,
    session.userId,
    session.tokenHash,
    session.createdAt,
    session.expiresAt
  );

  return session;
}

function requireAuthenticatedSession(request) {
  const session = getAuthenticatedSession(request);

  if (!session) {
    throw createHttpError(401, "Sua sessao expirou. Entre novamente.");
  }

  return session;
}

function getAuthenticatedSession(request) {
  const token = getSessionTokenFromRequest(request);

  if (!token) {
    return null;
  }

  const row = db.prepare(`
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
  `).get(hashSessionToken(token), new Date().toISOString());

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
  const cookies = parseCookies(request.headers.cookie || "");
  return cookies[SESSION_COOKIE_NAME] || "";
}

function setSessionCookie(response, token) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=${token}; Max-Age=${SESSION_MAX_AGE_SECONDS}; Path=/; HttpOnly; SameSite=Lax`);
}

function clearSessionCookie(response) {
  response.setHeader("Set-Cookie", `${SESSION_COOKIE_NAME}=; Max-Age=0; Path=/; HttpOnly; SameSite=Lax`);
}

function deleteSessionByToken(token) {
  if (!token) {
    return;
  }

  db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashSessionToken(token));
}

function cleanupExpiredSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(new Date().toISOString());
}

function getMaterialById(materialId) {
  return db.prepare(`
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
  `).get(materialId) || null;
}

function getUserByUsername(username) {
  return db.prepare(`
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
  `).get(username) || null;
}

function getUserCount() {
  return db.prepare("SELECT COUNT(*) AS total FROM users").get().total;
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

function runInTransaction(callback) {
  db.exec("BEGIN");

  try {
    callback();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}
