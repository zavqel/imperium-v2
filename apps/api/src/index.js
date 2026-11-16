import { AvailabilityCoordinator } from "./availability-coordinator.js";

export { AvailabilityCoordinator };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const SESSION_TTL_SECONDS = 8 * 60 * 60;
const PASSWORD_ITERATIONS = 600_000;
const DEFAULTS = Object.freeze({
  opensAtMinute: 480,
  closesAtMinute: 1020,
  slotIntervalMinutes: 30,
  minimumLeadMinutes: 120,
  capacity: 1,
});

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
});

const asPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

const asNonNegativeInt = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

function booleanValue(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === "1") return true;
  if (value === false || value === 0 || value === "0") return false;
  throw new HttpError(400, "Valor booleano inválido.");
}

function requiredText(value, label, max = 160) {
  const text = String(value ?? "").trim();
  if (!text || text.length > max) throw new HttpError(400, `${label} é obrigatório e deve ter no máximo ${max} caracteres.`);
  return text;
}

function optionalText(value, label, max = 2_000) {
  if (value === undefined || value === null || value === "") return null;
  const text = String(value).trim();
  if (text.length > max) throw new HttpError(400, `${label} deve ter no máximo ${max} caracteres.`);
  return text || null;
}

function normalizeName(value) {
  return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().trim().replace(/\s+/g, " ");
}

function slugify(value) {
  const slug = normalizeName(value).replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug || slug.length > 120) throw new HttpError(400, "Slug inválido.");
  return slug;
}

function parseId(value, label) {
  const id = asPositiveInt(value);
  if (!id) throw new HttpError(400, `${label} inválido.`);
  return id;
}

function parseOptionalId(value, label) {
  if (value === undefined || value === null || value === "") return null;
  return parseId(value, label);
}

function parseMinute(value, label, { nullable = false, min = 0, max = 1439 } = {}) {
  if (nullable && (value === undefined || value === null || value === "")) return null;
  const minute = Number(value);
  if (!Number.isInteger(minute) || minute < min || minute > max) throw new HttpError(400, `${label} inválido.`);
  return minute;
}

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

async function parseJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 64 * 1024) throw new HttpError(413, "Corpo da requisição excede o limite.");
  try { return await request.json(); }
  catch { throw new HttpError(400, "JSON inválido."); }
}

function saoPauloNow() {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date()).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, minute: Number(parts.hour) * 60 + Number(parts.minute) };
}

function parseDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return null;
  const parsed = new Date(`${value}T12:00:00Z`);
  return Number.isNaN(parsed.getTime()) || !parsed.toISOString().startsWith(value) ? null : value;
}

function parseClock(value) {
  const match = /^(\d{2}):(\d{2})$/.exec(String(value));
  if (!match) return null;
  const minute = Number(match[1]) * 60 + Number(match[2]);
  return minute >= 0 && minute < 1440 ? minute : null;
}

async function settings(env) {
  const rows = await env.DB.prepare("SELECT key, value FROM business_settings").all();
  const values = Object.fromEntries((rows.results || []).map((row) => [row.key, Number(row.value)]));
  return {
    opensAtMinute: Number.isInteger(values.opens_at_minute) ? values.opens_at_minute : DEFAULTS.opensAtMinute,
    closesAtMinute: Number.isInteger(values.closes_at_minute) ? values.closes_at_minute : DEFAULTS.closesAtMinute,
    slotIntervalMinutes: Number.isInteger(values.slot_interval_minutes) ? values.slot_interval_minutes : DEFAULTS.slotIntervalMinutes,
    minimumLeadMinutes: Number.isInteger(values.minimum_lead_minutes) ? values.minimum_lead_minutes : DEFAULTS.minimumLeadMinutes,
    capacity: Number.isInteger(values.capacity) ? values.capacity : DEFAULTS.capacity,
  };
}

function toBase64Url(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fromBase64Url(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new HttpError(401, "Sessão inválida.");
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - value.length % 4) % 4);
  try {
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    throw new HttpError(401, "Sessão inválida.");
  }
}

async function digest(value) {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

async function safelyMatches(left, right) {
  const [leftDigest, rightDigest] = await Promise.all([digest(left), digest(right)]);
  return leftDigest.byteLength === rightDigest.byteLength && crypto.subtle.timingSafeEqual(leftDigest, rightDigest);
}

function adminSecret(env, key) {
  const secret = String(env[key] || "");
  if (secret.length < 32) throw new HttpError(503, "A segurança do painel ainda não foi configurada.");
  return secret;
}

async function signSession(payload, secret) {
  const header = toBase64Url(encoder.encode(JSON.stringify({ alg: "HS256", typ: "JWT" })));
  const body = toBase64Url(encoder.encode(JSON.stringify(payload)));
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`)));
  return `${header}.${body}.${toBase64Url(signature)}`;
}

async function verifySession(token, secret) {
  const [header, body, provided] = String(token || "").split(".");
  if (!header || !body || !provided) throw new HttpError(401, "Sessão inválida.");
  let parsedHeader;
  let payload;
  try {
    parsedHeader = JSON.parse(decoder.decode(fromBase64Url(header)));
    payload = JSON.parse(decoder.decode(fromBase64Url(body)));
  } catch {
    throw new HttpError(401, "Sessão inválida.");
  }
  if (parsedHeader.alg !== "HS256" || !Number.isSafeInteger(payload.sub) || !Number.isSafeInteger(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
    throw new HttpError(401, "Sua sessão expirou. Entre novamente.");
  }
  const key = await crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(`${header}.${body}`)));
  const signature = fromBase64Url(provided);
  if (expected.byteLength !== signature.byteLength || !crypto.subtle.timingSafeEqual(expected, signature)) throw new HttpError(401, "Sessão inválida.");
  return payload;
}

async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations: PASSWORD_ITERATIONS }, key, 256);
  return `pbkdf2-sha256$${PASSWORD_ITERATIONS}$${toBase64Url(salt)}$${toBase64Url(new Uint8Array(bits))}`;
}

async function passwordMatches(password, storedHash) {
  const [algorithm, iterations, salt, hash] = String(storedHash).split("$");
  const rounds = Number(iterations);
  if (algorithm !== "pbkdf2-sha256" || !Number.isSafeInteger(rounds) || rounds < 100_000 || !salt || !hash) return false;
  try {
    const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
    const bits = new Uint8Array(await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: fromBase64Url(salt), iterations: rounds }, key, 256));
    const expected = fromBase64Url(hash);
    return bits.byteLength === expected.byteLength && crypto.subtle.timingSafeEqual(bits, expected);
  } catch {
    return false;
  }
}

function parseEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, "E-mail inválido.");
  return email;
}

function parsePassword(value) {
  const password = String(value || "");
  if (password.length < 12 || password.length > 128) throw new HttpError(400, "A senha deve ter entre 12 e 128 caracteres.");
  return password;
}

async function audit(env, user, action, entityType, entityId, beforeState = null, afterState = null) {
  await env.DB.prepare(`INSERT INTO audit_logs (actor_user_id, action, entity_type, entity_id, before_state, after_state)
    VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(user?.id || null, action, entityType, entityId === null ? null : String(entityId), beforeState === null ? null : JSON.stringify(beforeState), afterState === null ? null : JSON.stringify(afterState)).run();
}

async function bootstrapStatus(env) {
  const owner = await env.DB.prepare("SELECT id FROM admin_users WHERE role = 'owner' LIMIT 1").first();
  return { hasOwner: Boolean(owner), bootstrapConfigured: String(env.ADMIN_BOOTSTRAP_TOKEN || "").length >= 32, sessionConfigured: String(env.ADMIN_SESSION_SECRET || "").length >= 32 };
}

async function bootstrapOwner(env, body) {
  const status = await bootstrapStatus(env);
  if (status.hasOwner) throw new HttpError(409, "O administrador inicial já foi criado.");
  const bootstrapToken = requiredText(body.bootstrapToken, "Código de configuração", 512);
  const expected = adminSecret(env, "ADMIN_BOOTSTRAP_TOKEN");
  if (!(await safelyMatches(bootstrapToken, expected))) throw new HttpError(401, "Código de configuração inválido.");
  const email = parseEmail(body.email);
  const displayName = requiredText(body.displayName, "Nome", 100);
  const password = parsePassword(body.password);
  const passwordHash = await hashPassword(password);
  try {
    const created = await env.DB.prepare(`INSERT INTO admin_users (email, display_name, password_hash, role, active)
      VALUES (?, ?, ?, 'owner', 1) RETURNING id, email, display_name, role`).bind(email, displayName, passwordHash).first();
    await audit(env, created, "bootstrap", "admin_user", created.id, null, { id: created.id, email: created.email, role: created.role });
    return { user: { id: created.id, email: created.email, displayName: created.display_name, role: created.role } };
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new HttpError(409, "O administrador inicial já foi criado ou esse e-mail já está em uso.");
    throw error;
  }
}

async function login(env, body) {
  const email = parseEmail(body.email);
  const password = parsePassword(body.password);
  const user = await env.DB.prepare("SELECT id, email, display_name, password_hash, role, active FROM admin_users WHERE email = ? LIMIT 1").bind(email).first();
  if (!user || !user.active || !(await passwordMatches(password, user.password_hash))) throw new HttpError(401, "E-mail ou senha inválidos.");
  const now = Math.floor(Date.now() / 1000);
  const token = await signSession({ sub: user.id, exp: now + SESSION_TTL_SECONDS }, adminSecret(env, "ADMIN_SESSION_SECRET"));
  return { token, expiresAt: new Date((now + SESSION_TTL_SECONDS) * 1000).toISOString(), user: { id: user.id, email: user.email, displayName: user.display_name, role: user.role } };
}

async function authenticatedUser(request, env) {
  const authorization = request.headers.get("Authorization") || "";
  const match = /^Bearer\s+(.+)$/i.exec(authorization);
  if (!match) throw new HttpError(401, "Entre para acessar o painel.");
  const claims = await verifySession(match[1], adminSecret(env, "ADMIN_SESSION_SECRET"));
  const user = await env.DB.prepare("SELECT id, email, display_name, role, active FROM admin_users WHERE id = ? LIMIT 1").bind(claims.sub).first();
  if (!user || !user.active) throw new HttpError(401, "Sua sessão não está mais ativa.");
  return { id: user.id, email: user.email, displayName: user.display_name, role: user.role };
}

async function quote(env, input) {
  const modelId = asPositiveInt(input.modelId);
  const serviceId = asPositiveInt(input.serviceId);
  const addonIds = [...new Set((Array.isArray(input.addonIds) ? input.addonIds : []).map(asPositiveInt).filter(Boolean))];
  if (!modelId || !serviceId) throw new HttpError(400, "Modelo e serviço principal são obrigatórios.");

  const model = await env.DB.prepare(`SELECT vm.id, vm.name, vc.id AS category_id, vc.name AS category_name, mk.name AS make_name
    FROM vehicle_models vm JOIN vehicle_categories vc ON vc.id = vm.vehicle_category_id
    JOIN vehicle_makes mk ON mk.id = vm.make_id WHERE vm.id = ? AND vm.active = 1 AND mk.active = 1 AND vc.active = 1`).bind(modelId).first();
  if (!model) throw new HttpError(404, "Modelo de veículo não encontrado.");

  const service = await env.DB.prepare("SELECT id, name, pricing_mode, fixed_price_cents, duration_minutes, last_start_minute FROM services WHERE id = ? AND active = 1").bind(serviceId).first();
  if (!service) throw new HttpError(404, "Serviço principal não encontrado.");

  const override = await env.DB.prepare("SELECT price_cents FROM model_service_price_overrides WHERE vehicle_model_id = ? AND service_id = ? AND active = 1").bind(modelId, serviceId).first();
  const categoryPrice = await env.DB.prepare("SELECT price_cents FROM category_service_prices WHERE vehicle_category_id = ? AND service_id = ?").bind(model.category_id, serviceId).first();
  const servicePrice = override?.price_cents ?? (service.pricing_mode === "fixed" ? service.fixed_price_cents : categoryPrice?.price_cents);
  if (!Number.isInteger(servicePrice)) throw new HttpError(422, "Este serviço ainda não possui preço para a categoria do veículo.");

  const items = [{ kind: "service", id: service.id, name: service.name, priceCents: servicePrice, durationMinutes: service.duration_minutes, pricingSource: override ? "model_override" : service.pricing_mode === "fixed" ? "fixed" : "vehicle_category" }];
  for (const addonId of addonIds) {
    const addon = await env.DB.prepare(`SELECT a.id, a.name, a.pricing_mode, a.fixed_price_cents, a.duration_minutes
      FROM addons a JOIN service_addon_compatibility c ON c.addon_id = a.id
      WHERE a.id = ? AND c.service_id = ? AND a.active = 1`).bind(addonId, serviceId).first();
    if (!addon) throw new HttpError(422, "Um adicional selecionado não é compatível com o serviço.");
    const categoryAddonPrice = await env.DB.prepare("SELECT price_cents FROM category_addon_prices WHERE vehicle_category_id = ? AND addon_id = ?").bind(model.category_id, addonId).first();
    const price = addon.pricing_mode === "fixed" ? addon.fixed_price_cents : categoryAddonPrice?.price_cents;
    if (!Number.isInteger(price)) throw new HttpError(422, "Um adicional não possui preço para a categoria do veículo.");
    items.push({ kind: "addon", id: addon.id, name: addon.name, priceCents: price, durationMinutes: addon.duration_minutes, pricingSource: addon.pricing_mode === "fixed" ? "fixed" : "vehicle_category" });
  }

  const subtotalCents = items.reduce((total, item) => total + item.priceCents, 0);
  const discount = await env.DB.prepare(`SELECT percent_basis_points FROM discount_rules
    WHERE active = 1 AND minimum_cents <= ? AND (starts_at IS NULL OR starts_at <= CURRENT_TIMESTAMP)
    AND (ends_at IS NULL OR ends_at >= CURRENT_TIMESTAMP) ORDER BY minimum_cents DESC LIMIT 1`).bind(subtotalCents).first();
  const discountCents = discount ? Math.floor(subtotalCents * Number(discount.percent_basis_points) / 10000) : 0;
  return {
    vehicle: { modelId: model.id, label: `${model.make_name} ${model.name}`, category: model.category_name },
    service: { id: service.id, lastStartMinute: service.last_start_minute },
    items,
    durationMinutes: items.reduce((total, item) => total + item.durationMinutes, 0),
    subtotalCents,
    discountCents,
    totalCents: subtotalCents - discountCents,
  };
}

async function createHold(env, body) {
  const date = parseDate(body.date);
  const startsAtMinute = parseClock(body.startTime);
  if (!date || startsAtMinute === null) throw new HttpError(400, "Data ou horário inválido.");
  const calculation = await quote(env, body);
  const config = await settings(env);
  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const dayHours = await env.DB.prepare("SELECT opens_at_minute, closes_at_minute, active FROM operating_hours WHERE weekday = ?").bind(weekday).first();
  if (dayHours && !dayHours.active) throw new HttpError(422, "Não há atendimento nesta data.");
  const opensAtMinute = dayHours ? dayHours.opens_at_minute : config.opensAtMinute;
  const closesAtMinute = dayHours ? dayHours.closes_at_minute : config.closesAtMinute;
  const endsAtMinute = startsAtMinute + calculation.durationMinutes;
  const now = saoPauloNow();
  if (date < now.date || (date === now.date && startsAtMinute < now.minute + config.minimumLeadMinutes)) throw new HttpError(422, "A antecedência mínima não foi respeitada.");
  if (startsAtMinute < opensAtMinute || endsAtMinute > closesAtMinute || startsAtMinute % config.slotIntervalMinutes !== 0) throw new HttpError(422, "Horário fora do expediente.");
  if (calculation.service.lastStartMinute !== null && startsAtMinute > calculation.service.lastStartMinute) throw new HttpError(422, "O horário é posterior ao limite deste serviço.");

  const holdId = crypto.randomUUID();
  const expiresAtMs = Date.now() + Math.max(1, Number(env.HOLD_DURATION_MINUTES) || 10) * 60_000;
  const coordinator = env.AVAILABILITY.getByName(`imperium:${date}`);
  const reservation = await coordinator.reserve({ holdId, startsAtMinute, endsAtMinute, expiresAt: expiresAtMs, capacity: config.capacity });
  if (!reservation.reserved) throw new HttpError(409, "Este horário acabou de ser ocupado. Escolha outro.");

  try {
    await env.DB.prepare(`INSERT INTO slot_holds (id, date, starts_at_minute, ends_at_minute, expires_at, quote_snapshot)
      VALUES (?, ?, ?, ?, datetime(? / 1000, 'unixepoch'), ?)`)
      .bind(holdId, date, startsAtMinute, endsAtMinute, expiresAtMs, JSON.stringify(calculation)).run();
  } catch (error) {
    await coordinator.release(holdId);
    throw error;
  }
  return { holdId, expiresAt: new Date(expiresAtMs).toISOString(), quote: calculation };
}

async function listMakes(env, url) {
  const search = `%${String(url.searchParams.get("q") || "").trim().toLowerCase()}%`;
  const result = await env.DB.prepare("SELECT id, name FROM vehicle_makes WHERE active = 1 AND normalized_name LIKE ? ORDER BY name LIMIT 20").bind(search).all();
  return result.results || [];
}

async function listModels(env, url) {
  const makeId = asPositiveInt(url.searchParams.get("makeId"));
  if (!makeId) throw new HttpError(400, "Marca inválida.");
  const search = `%${String(url.searchParams.get("q") || "").trim().toLowerCase()}%`;
  const result = await env.DB.prepare(`SELECT vm.id, vm.name, vc.name AS category FROM vehicle_models vm
    JOIN vehicle_categories vc ON vc.id = vm.vehicle_category_id
    WHERE vm.make_id = ? AND vm.active = 1 AND vc.active = 1 AND vm.normalized_name LIKE ? ORDER BY vm.name LIMIT 30`).bind(makeId, search).all();
  return result.results || [];
}

async function exists(env, table, id, label) {
  const allowed = new Set(["vehicle_categories", "vehicle_makes", "vehicle_models", "service_categories", "services", "addons"]);
  if (!allowed.has(table)) throw new Error("Tabela não permitida.");
  const row = await env.DB.prepare(`SELECT id FROM ${table} WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, `${label} não encontrado.`);
}

function parseSimpleCatalog(body, current = null) {
  const name = requiredText(body.name === undefined ? current?.name : body.name, "Nome");
  const sortOrder = asNonNegativeInt(body.sortOrder === undefined ? current?.sort_order ?? 0 : body.sortOrder);
  if (sortOrder === null) throw new HttpError(400, "Ordem inválida.");
  const active = booleanValue(body.active, current ? Boolean(current.active) : true);
  return { name, sortOrder, active };
}

async function vehicleCategories(env, method, id, body, user) {
  if (method === "GET") {
    const result = await env.DB.prepare("SELECT id, name, active, sort_order AS sortOrder FROM vehicle_categories ORDER BY sort_order, name").all();
    return { items: result.results || [] };
  }
  if (method === "POST") {
    const values = parseSimpleCatalog(body);
    const created = await env.DB.prepare("INSERT INTO vehicle_categories (name, active, sort_order) VALUES (?, ?, ?) RETURNING id, name, active, sort_order AS sortOrder")
      .bind(values.name, Number(values.active), values.sortOrder).first();
    await audit(env, user, "create", "vehicle_category", created.id, null, created);
    return { item: created };
  }
  const current = await env.DB.prepare("SELECT id, name, active, sort_order FROM vehicle_categories WHERE id = ?").bind(id).first();
  if (!current) throw new HttpError(404, "Categoria de veículo não encontrada.");
  const values = parseSimpleCatalog(body, current);
  const updated = await env.DB.prepare("UPDATE vehicle_categories SET name = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, name, active, sort_order AS sortOrder")
    .bind(values.name, Number(values.active), values.sortOrder, id).first();
  await audit(env, user, "update", "vehicle_category", id, current, updated);
  return { item: updated };
}

async function vehicleMakes(env, method, id, body, user) {
  if (method === "GET") {
    const result = await env.DB.prepare("SELECT id, name, normalized_name AS normalizedName, active FROM vehicle_makes ORDER BY name").all();
    return { items: result.results || [] };
  }
  if (method === "POST") {
    const name = requiredText(body.name, "Nome");
    const active = booleanValue(body.active, true);
    const created = await env.DB.prepare("INSERT INTO vehicle_makes (name, normalized_name, active) VALUES (?, ?, ?) RETURNING id, name, normalized_name AS normalizedName, active")
      .bind(name, normalizeName(name), Number(active)).first();
    await audit(env, user, "create", "vehicle_make", created.id, null, created);
    return { item: created };
  }
  const current = await env.DB.prepare("SELECT id, name, normalized_name, active FROM vehicle_makes WHERE id = ?").bind(id).first();
  if (!current) throw new HttpError(404, "Marca não encontrada.");
  const name = requiredText(body.name === undefined ? current.name : body.name, "Nome");
  const active = booleanValue(body.active, Boolean(current.active));
  const updated = await env.DB.prepare("UPDATE vehicle_makes SET name = ?, normalized_name = ?, active = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, name, normalized_name AS normalizedName, active")
    .bind(name, normalizeName(name), Number(active), id).first();
  await audit(env, user, "update", "vehicle_make", id, current, updated);
  return { item: updated };
}

function parseModel(body, current = null) {
  const makeId = parseId(body.makeId === undefined ? current?.make_id : body.makeId, "Marca");
  const vehicleCategoryId = parseId(body.vehicleCategoryId === undefined ? current?.vehicle_category_id : body.vehicleCategoryId, "Categoria de veículo");
  const name = requiredText(body.name === undefined ? current?.name : body.name, "Nome");
  const active = booleanValue(body.active, current ? Boolean(current.active) : true);
  return { makeId, vehicleCategoryId, name, active };
}

async function vehicleModels(env, method, id, body, user) {
  if (method === "GET") {
    const result = await env.DB.prepare(`SELECT vm.id, vm.name, vm.make_id AS makeId, mk.name AS makeName, vm.vehicle_category_id AS vehicleCategoryId,
      vc.name AS vehicleCategoryName, vm.active FROM vehicle_models vm JOIN vehicle_makes mk ON mk.id = vm.make_id
      JOIN vehicle_categories vc ON vc.id = vm.vehicle_category_id ORDER BY mk.name, vm.name`).all();
    return { items: result.results || [] };
  }
  const current = id ? await env.DB.prepare("SELECT id, make_id, vehicle_category_id, name, normalized_name, active FROM vehicle_models WHERE id = ?").bind(id).first() : null;
  if (id && !current) throw new HttpError(404, "Modelo não encontrado.");
  const values = parseModel(body, current);
  await Promise.all([exists(env, "vehicle_makes", values.makeId, "Marca"), exists(env, "vehicle_categories", values.vehicleCategoryId, "Categoria de veículo")]);
  if (method === "POST") {
    const created = await env.DB.prepare(`INSERT INTO vehicle_models (make_id, vehicle_category_id, name, normalized_name, active)
      VALUES (?, ?, ?, ?, ?) RETURNING id, make_id AS makeId, vehicle_category_id AS vehicleCategoryId, name, active`)
      .bind(values.makeId, values.vehicleCategoryId, values.name, normalizeName(values.name), Number(values.active)).first();
    await audit(env, user, "create", "vehicle_model", created.id, null, created);
    return { item: created };
  }
  const updated = await env.DB.prepare(`UPDATE vehicle_models SET make_id = ?, vehicle_category_id = ?, name = ?, normalized_name = ?, active = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? RETURNING id, make_id AS makeId, vehicle_category_id AS vehicleCategoryId, name, active`)
    .bind(values.makeId, values.vehicleCategoryId, values.name, normalizeName(values.name), Number(values.active), id).first();
  await audit(env, user, "update", "vehicle_model", id, current, updated);
  return { item: updated };
}

async function serviceCategories(env, method, id, body, user) {
  if (method === "GET") {
    const result = await env.DB.prepare("SELECT id, name, active, sort_order AS sortOrder FROM service_categories ORDER BY sort_order, name").all();
    return { items: result.results || [] };
  }
  if (method === "POST") {
    const values = parseSimpleCatalog(body);
    const created = await env.DB.prepare("INSERT INTO service_categories (name, active, sort_order) VALUES (?, ?, ?) RETURNING id, name, active, sort_order AS sortOrder")
      .bind(values.name, Number(values.active), values.sortOrder).first();
    await audit(env, user, "create", "service_category", created.id, null, created);
    return { item: created };
  }
  const current = await env.DB.prepare("SELECT id, name, active, sort_order FROM service_categories WHERE id = ?").bind(id).first();
  if (!current) throw new HttpError(404, "Categoria de serviço não encontrada.");
  const values = parseSimpleCatalog(body, current);
  const updated = await env.DB.prepare("UPDATE service_categories SET name = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, name, active, sort_order AS sortOrder")
    .bind(values.name, Number(values.active), values.sortOrder, id).first();
  await audit(env, user, "update", "service_category", id, current, updated);
  return { item: updated };
}

function parseService(body, current = null) {
  const name = requiredText(body.name === undefined ? current?.name : body.name, "Nome");
  const slug = body.slug === undefined ? (current?.slug || slugify(name)) : slugify(body.slug);
  const serviceCategoryId = parseOptionalId(body.serviceCategoryId === undefined ? current?.service_category_id : body.serviceCategoryId, "Categoria de serviço");
  const pricingMode = body.pricingMode === undefined ? current?.pricing_mode || "vehicle_category" : String(body.pricingMode);
  if (!["fixed", "vehicle_category"].includes(pricingMode)) throw new HttpError(400, "Modo de preço inválido.");
  const fixedCandidate = body.fixedPriceCents === undefined ? current?.fixed_price_cents : body.fixedPriceCents;
  const fixedPriceCents = pricingMode === "fixed" ? asNonNegativeInt(fixedCandidate) : null;
  if (pricingMode === "fixed" && fixedPriceCents === null) throw new HttpError(400, "Informe o preço fixo em centavos.");
  const durationMinutes = parseMinute(body.durationMinutes === undefined ? current?.duration_minutes : body.durationMinutes, "Duração", { min: 1 });
  const lastStartMinute = parseMinute(body.lastStartMinute === undefined ? current?.last_start_minute : body.lastStartMinute, "Último horário de início", { nullable: true });
  const active = booleanValue(body.active, current ? Boolean(current.active) : true);
  const sortOrder = asNonNegativeInt(body.sortOrder === undefined ? current?.sort_order ?? 0 : body.sortOrder);
  if (sortOrder === null) throw new HttpError(400, "Ordem inválida.");
  return { name, slug, serviceCategoryId, shortDescription: optionalText(body.shortDescription === undefined ? current?.short_description : body.shortDescription, "Descrição curta", 320), fullDescription: optionalText(body.fullDescription === undefined ? current?.full_description : body.fullDescription, "Descrição", 3_000), imageKey: optionalText(body.imageKey === undefined ? current?.image_key : body.imageKey, "Imagem", 500), pricingMode, fixedPriceCents, durationMinutes, lastStartMinute, active, sortOrder };
}

async function services(env, method, id, body, user) {
  if (method === "GET") {
    const result = await env.DB.prepare(`SELECT s.id, s.name, s.slug, s.service_category_id AS serviceCategoryId, sc.name AS serviceCategoryName,
      s.short_description AS shortDescription, s.full_description AS fullDescription, s.image_key AS imageKey, s.pricing_mode AS pricingMode,
      s.fixed_price_cents AS fixedPriceCents, s.duration_minutes AS durationMinutes, s.last_start_minute AS lastStartMinute,
      s.active, s.sort_order AS sortOrder FROM services s LEFT JOIN service_categories sc ON sc.id = s.service_category_id ORDER BY s.sort_order, s.name`).all();
    return { items: result.results || [] };
  }
  const current = id ? await env.DB.prepare("SELECT * FROM services WHERE id = ?").bind(id).first() : null;
  if (id && !current) throw new HttpError(404, "Serviço não encontrado.");
  const values = parseService(body, current);
  if (values.serviceCategoryId) await exists(env, "service_categories", values.serviceCategoryId, "Categoria de serviço");
  if (method === "POST") {
    const created = await env.DB.prepare(`INSERT INTO services (service_category_id, name, slug, short_description, full_description, image_key, pricing_mode, fixed_price_cents, duration_minutes, last_start_minute, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, name, slug, active`).bind(values.serviceCategoryId, values.name, values.slug, values.shortDescription, values.fullDescription, values.imageKey, values.pricingMode, values.fixedPriceCents, values.durationMinutes, values.lastStartMinute, Number(values.active), values.sortOrder).first();
    await audit(env, user, "create", "service", created.id, null, created);
    return { item: created };
  }
  const updated = await env.DB.prepare(`UPDATE services SET service_category_id = ?, name = ?, slug = ?, short_description = ?, full_description = ?, image_key = ?, pricing_mode = ?, fixed_price_cents = ?, duration_minutes = ?, last_start_minute = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, name, slug, active`)
    .bind(values.serviceCategoryId, values.name, values.slug, values.shortDescription, values.fullDescription, values.imageKey, values.pricingMode, values.fixedPriceCents, values.durationMinutes, values.lastStartMinute, Number(values.active), values.sortOrder, id).first();
  await audit(env, user, "update", "service", id, current, updated);
  return { item: updated };
}

function parseAddon(body, current = null) {
  const name = requiredText(body.name === undefined ? current?.name : body.name, "Nome");
  const slug = body.slug === undefined ? (current?.slug || slugify(name)) : slugify(body.slug);
  const pricingMode = body.pricingMode === undefined ? current?.pricing_mode || "fixed" : String(body.pricingMode);
  if (!["fixed", "vehicle_category"].includes(pricingMode)) throw new HttpError(400, "Modo de preço inválido.");
  const fixedCandidate = body.fixedPriceCents === undefined ? current?.fixed_price_cents : body.fixedPriceCents;
  const fixedPriceCents = pricingMode === "fixed" ? asNonNegativeInt(fixedCandidate) : null;
  if (pricingMode === "fixed" && fixedPriceCents === null) throw new HttpError(400, "Informe o preço fixo em centavos.");
  const durationMinutes = parseMinute(body.durationMinutes === undefined ? current?.duration_minutes : body.durationMinutes, "Duração", { min: 0 });
  const active = booleanValue(body.active, current ? Boolean(current.active) : true);
  const sortOrder = asNonNegativeInt(body.sortOrder === undefined ? current?.sort_order ?? 0 : body.sortOrder);
  if (sortOrder === null) throw new HttpError(400, "Ordem inválida.");
  return { name, slug, description: optionalText(body.description === undefined ? current?.description : body.description, "Descrição", 3_000), imageKey: optionalText(body.imageKey === undefined ? current?.image_key : body.imageKey, "Imagem", 500), pricingMode, fixedPriceCents, durationMinutes, active, sortOrder };
}

async function addons(env, method, id, body, user) {
  if (method === "GET") {
    const result = await env.DB.prepare("SELECT id, name, slug, description, image_key AS imageKey, pricing_mode AS pricingMode, fixed_price_cents AS fixedPriceCents, duration_minutes AS durationMinutes, active, sort_order AS sortOrder FROM addons ORDER BY sort_order, name").all();
    return { items: result.results || [] };
  }
  const current = id ? await env.DB.prepare("SELECT * FROM addons WHERE id = ?").bind(id).first() : null;
  if (id && !current) throw new HttpError(404, "Adicional não encontrado.");
  const values = parseAddon(body, current);
  if (method === "POST") {
    const created = await env.DB.prepare(`INSERT INTO addons (name, slug, description, image_key, pricing_mode, fixed_price_cents, duration_minutes, active, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id, name, slug, active`).bind(values.name, values.slug, values.description, values.imageKey, values.pricingMode, values.fixedPriceCents, values.durationMinutes, Number(values.active), values.sortOrder).first();
    await audit(env, user, "create", "addon", created.id, null, created);
    return { item: created };
  }
  const updated = await env.DB.prepare(`UPDATE addons SET name = ?, slug = ?, description = ?, image_key = ?, pricing_mode = ?, fixed_price_cents = ?, duration_minutes = ?, active = ?, sort_order = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? RETURNING id, name, slug, active`)
    .bind(values.name, values.slug, values.description, values.imageKey, values.pricingMode, values.fixedPriceCents, values.durationMinutes, Number(values.active), values.sortOrder, id).first();
  await audit(env, user, "update", "addon", id, current, updated);
  return { item: updated };
}

async function pricing(env) {
  const [categories, models, servicesList, addonsList, categoryServicePrices, categoryAddonPrices, modelServiceOverrides, compatibilities] = await Promise.all([
    env.DB.prepare("SELECT id, name, active FROM vehicle_categories ORDER BY name").all(),
    env.DB.prepare("SELECT vm.id, vm.name, mk.name AS makeName FROM vehicle_models vm JOIN vehicle_makes mk ON mk.id = vm.make_id ORDER BY mk.name, vm.name").all(),
    env.DB.prepare("SELECT id, name, pricing_mode AS pricingMode FROM services ORDER BY name").all(),
    env.DB.prepare("SELECT id, name, pricing_mode AS pricingMode FROM addons ORDER BY name").all(),
    env.DB.prepare("SELECT vehicle_category_id AS vehicleCategoryId, service_id AS serviceId, price_cents AS priceCents FROM category_service_prices").all(),
    env.DB.prepare("SELECT vehicle_category_id AS vehicleCategoryId, addon_id AS addonId, price_cents AS priceCents FROM category_addon_prices").all(),
    env.DB.prepare("SELECT vehicle_model_id AS vehicleModelId, service_id AS serviceId, price_cents AS priceCents, active FROM model_service_price_overrides").all(),
    env.DB.prepare("SELECT service_id AS serviceId, addon_id AS addonId FROM service_addon_compatibility").all(),
  ]);
  return { categories: categories.results || [], models: models.results || [], services: servicesList.results || [], addons: addonsList.results || [], categoryServicePrices: categoryServicePrices.results || [], categoryAddonPrices: categoryAddonPrices.results || [], modelServiceOverrides: modelServiceOverrides.results || [], compatibilities: compatibilities.results || [] };
}

async function updatePrice(env, user, body, kind) {
  const priceCents = asNonNegativeInt(body.priceCents);
  if (priceCents === null) throw new HttpError(400, "Preço em centavos inválido.");
  if (kind === "category-service") {
    const categoryId = parseId(body.vehicleCategoryId, "Categoria de veículo");
    const serviceId = parseId(body.serviceId, "Serviço");
    await Promise.all([exists(env, "vehicle_categories", categoryId, "Categoria de veículo"), exists(env, "services", serviceId, "Serviço")]);
    await env.DB.prepare(`INSERT INTO category_service_prices (vehicle_category_id, service_id, price_cents) VALUES (?, ?, ?)
      ON CONFLICT(vehicle_category_id, service_id) DO UPDATE SET price_cents = excluded.price_cents`).bind(categoryId, serviceId, priceCents).run();
    await audit(env, user, "upsert_price", "category_service_price", `${categoryId}:${serviceId}`, null, { categoryId, serviceId, priceCents });
  } else if (kind === "category-addon") {
    const categoryId = parseId(body.vehicleCategoryId, "Categoria de veículo");
    const addonId = parseId(body.addonId, "Adicional");
    await Promise.all([exists(env, "vehicle_categories", categoryId, "Categoria de veículo"), exists(env, "addons", addonId, "Adicional")]);
    await env.DB.prepare(`INSERT INTO category_addon_prices (vehicle_category_id, addon_id, price_cents) VALUES (?, ?, ?)
      ON CONFLICT(vehicle_category_id, addon_id) DO UPDATE SET price_cents = excluded.price_cents`).bind(categoryId, addonId, priceCents).run();
    await audit(env, user, "upsert_price", "category_addon_price", `${categoryId}:${addonId}`, null, { categoryId, addonId, priceCents });
  } else {
    const modelId = parseId(body.vehicleModelId, "Modelo");
    const serviceId = parseId(body.serviceId, "Serviço");
    const active = booleanValue(body.active, true);
    await Promise.all([exists(env, "vehicle_models", modelId, "Modelo"), exists(env, "services", serviceId, "Serviço")]);
    await env.DB.prepare(`INSERT INTO model_service_price_overrides (vehicle_model_id, service_id, price_cents, active) VALUES (?, ?, ?, ?)
      ON CONFLICT(vehicle_model_id, service_id) DO UPDATE SET price_cents = excluded.price_cents, active = excluded.active`).bind(modelId, serviceId, priceCents, Number(active)).run();
    await audit(env, user, "upsert_price", "model_service_price_override", `${modelId}:${serviceId}`, null, { modelId, serviceId, priceCents, active });
  }
  return { ok: true };
}

async function setCompatibility(env, user, body) {
  const serviceId = parseId(body.serviceId, "Serviço");
  const addonIds = [...new Set((Array.isArray(body.addonIds) ? body.addonIds : []).map((id) => parseId(id, "Adicional")))];
  await exists(env, "services", serviceId, "Serviço");
  await Promise.all(addonIds.map((id) => exists(env, "addons", id, "Adicional")));
  const commands = [env.DB.prepare("DELETE FROM service_addon_compatibility WHERE service_id = ?").bind(serviceId), ...addonIds.map((addonId) => env.DB.prepare("INSERT INTO service_addon_compatibility (service_id, addon_id) VALUES (?, ?)").bind(serviceId, addonId))];
  await env.DB.batch(commands);
  await audit(env, user, "set_compatibility", "service_addons", serviceId, null, { addonIds });
  return { ok: true };
}

async function operations(env) {
  const [availability, hours] = await Promise.all([settings(env), env.DB.prepare("SELECT weekday, opens_at_minute AS opensAtMinute, closes_at_minute AS closesAtMinute, active FROM operating_hours ORDER BY weekday").all()]);
  return { availability, operatingHours: hours.results || [] };
}

async function updateOperations(env, user, body) {
  const current = await settings(env);
  const incoming = body.settings || {};
  const next = {
    opensAtMinute: parseMinute(incoming.opensAtMinute === undefined ? current.opensAtMinute : incoming.opensAtMinute, "Abertura", { max: 1438 }),
    closesAtMinute: parseMinute(incoming.closesAtMinute === undefined ? current.closesAtMinute : incoming.closesAtMinute, "Fechamento", { min: 1, max: 1440 }),
    slotIntervalMinutes: parseMinute(incoming.slotIntervalMinutes === undefined ? current.slotIntervalMinutes : incoming.slotIntervalMinutes, "Intervalo", { min: 5, max: 240 }),
    minimumLeadMinutes: parseMinute(incoming.minimumLeadMinutes === undefined ? current.minimumLeadMinutes : incoming.minimumLeadMinutes, "Antecedência", { min: 0, max: 10_080 }),
    capacity: parseMinute(incoming.capacity === undefined ? current.capacity : incoming.capacity, "Capacidade", { min: 1, max: 50 }),
  };
  if (next.closesAtMinute <= next.opensAtMinute) throw new HttpError(400, "O fechamento deve ser posterior à abertura.");
  const hours = body.operatingHours;
  const commands = Object.entries({ opens_at_minute: next.opensAtMinute, closes_at_minute: next.closesAtMinute, slot_interval_minutes: next.slotIntervalMinutes, minimum_lead_minutes: next.minimumLeadMinutes, capacity: next.capacity })
    .map(([key, value]) => env.DB.prepare(`INSERT INTO business_settings (key, value) VALUES (?, ?)
      ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`).bind(key, String(value)));
  if (hours !== undefined) {
    if (!Array.isArray(hours) || hours.length > 7) throw new HttpError(400, "Horários de operação inválidos.");
    const seen = new Set();
    for (const item of hours) {
      const weekday = parseMinute(item.weekday, "Dia da semana", { min: 0, max: 6 });
      if (seen.has(weekday)) throw new HttpError(400, "Dia da semana repetido.");
      seen.add(weekday);
      const opensAtMinute = parseMinute(item.opensAtMinute, "Abertura", { max: 1438 });
      const closesAtMinute = parseMinute(item.closesAtMinute, "Fechamento", { min: 1, max: 1440 });
      if (closesAtMinute <= opensAtMinute) throw new HttpError(400, "O fechamento deve ser posterior à abertura.");
      const active = booleanValue(item.active, true);
      commands.push(env.DB.prepare(`INSERT INTO operating_hours (weekday, opens_at_minute, closes_at_minute, active) VALUES (?, ?, ?, ?)
        ON CONFLICT(weekday) DO UPDATE SET opens_at_minute = excluded.opens_at_minute, closes_at_minute = excluded.closes_at_minute, active = excluded.active`).bind(weekday, opensAtMinute, closesAtMinute, Number(active)));
    }
  }
  await env.DB.batch(commands);
  await audit(env, user, "update", "operations", "settings", current, { ...next, operatingHours: hours ?? undefined });
  return operations(env);
}

async function dashboard(env) {
  const [categories, makes, models, servicesList, addonsList, bookings] = await Promise.all([
    env.DB.prepare("SELECT COUNT(*) AS total FROM vehicle_categories WHERE active = 1").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM vehicle_makes WHERE active = 1").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM vehicle_models WHERE active = 1").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM services WHERE active = 1").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM addons WHERE active = 1").first(),
    env.DB.prepare("SELECT COUNT(*) AS total FROM bookings WHERE date >= date('now') AND status NOT IN ('cancelled', 'completed')").first(),
  ]);
  return { counts: { vehicleCategories: categories.total, makes: makes.total, models: models.total, services: servicesList.total, addons: addonsList.total, upcomingBookings: bookings.total } };
}

function log(level, event, fields = {}) {
  const record = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(record); else console.log(record);
}

async function adminRoute(request, env, url) {
  const path = url.pathname;
  if (request.method === "GET" && path === "/v1/admin/bootstrap-status") return bootstrapStatus(env);
  if (request.method === "POST" && path === "/v1/admin/bootstrap") return bootstrapOwner(env, await parseJson(request));
  if (request.method === "POST" && path === "/v1/admin/login") return login(env, await parseJson(request));

  const user = await authenticatedUser(request, env);
  if (request.method === "GET" && path === "/v1/admin/session") return { user };
  if (request.method === "GET" && path === "/v1/admin/dashboard") return dashboard(env);
  if (request.method === "GET" && path === "/v1/admin/pricing") return pricing(env);
  if (request.method === "PUT" && path === "/v1/admin/pricing/category-service") return updatePrice(env, user, await parseJson(request), "category-service");
  if (request.method === "PUT" && path === "/v1/admin/pricing/category-addon") return updatePrice(env, user, await parseJson(request), "category-addon");
  if (request.method === "PUT" && path === "/v1/admin/pricing/model-service") return updatePrice(env, user, await parseJson(request), "model-service");
  if (request.method === "PUT" && path === "/v1/admin/pricing/service-addons") return setCompatibility(env, user, await parseJson(request));
  if (request.method === "GET" && path === "/v1/admin/operations") return operations(env);
  if (request.method === "PUT" && path === "/v1/admin/operations") return updateOperations(env, user, await parseJson(request));

  const catalogRoutes = [
    ["vehicle-categories", vehicleCategories],
    ["vehicle-makes", vehicleMakes],
    ["vehicle-models", vehicleModels],
    ["service-categories", serviceCategories],
    ["services", services],
    ["addons", addons],
  ];
  for (const [segment, handler] of catalogRoutes) {
    if (path === `/v1/admin/${segment}` && ["GET", "POST"].includes(request.method)) return handler(env, request.method, null, request.method === "POST" ? await parseJson(request) : null, user);
    const match = new RegExp(`^/v1/admin/${segment}/(\\d+)$`).exec(path);
    if (match && request.method === "PATCH") return handler(env, request.method, parseId(match[1], "Registro"), await parseJson(request), user);
  }
  throw new HttpError(404, "Rota não encontrada.");
}

export default {
  async fetch(request, env) {
    const cors = corsHeaders(request, env);
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/health")) {
        const database = await env.DB.prepare("SELECT 1 AS connected").first();
        return json({ ok: true, service: "imperium-v2-api", database: database?.connected === 1 ? "connected" : "unavailable" }, 200, cors);
      }
      if (request.method === "GET" && url.pathname === "/v1/public/vehicle-makes") return json({ items: await listMakes(env, url) }, 200, cors);
      if (request.method === "GET" && url.pathname === "/v1/public/vehicle-models") return json({ items: await listModels(env, url) }, 200, cors);
      if (request.method === "POST" && url.pathname === "/v1/public/quotes") return json(await quote(env, await parseJson(request)), 200, cors);
      if (request.method === "POST" && url.pathname === "/v1/public/holds") return json(await createHold(env, await parseJson(request)), 201, cors);
      if (url.pathname.startsWith("/v1/admin/")) return json(await adminRoute(request, env, url), 200, cors);
      return json({ error: "not_found" }, 404, cors);
    } catch (error) {
      const isHttpError = error instanceof HttpError;
      const constraint = /UNIQUE constraint failed|FOREIGN KEY constraint failed|constraint failed/i.test(String(error));
      const status = isHttpError ? error.status : constraint ? 409 : 500;
      const message = isHttpError ? error.message : constraint ? "Este registro conflita com um dado já cadastrado." : "Não foi possível concluir a operação.";
      if (status >= 500) log("error", "request_failed", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
      return json({ error: message }, status, cors);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(env.DB.prepare("UPDATE slot_holds SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP").run());
  },
};
