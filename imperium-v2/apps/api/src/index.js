import { AvailabilityCoordinator } from "./availability-coordinator.js";

export { AvailabilityCoordinator };

const DEFAULTS = Object.freeze({
  opensAtMinute: 480,
  closesAtMinute: 1020,
  slotIntervalMinutes: 30,
  minimumLeadMinutes: 120,
  capacity: 1,
});

const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { "content-type": "application/json; charset=utf-8", ...headers },
});

const asPositiveInt = (value) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
};

function corsHeaders(request, env) {
  const origin = request.headers.get("Origin");
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return {};
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Vary": "Origin",
  };
}

async function parseJson(request) {
  const contentLength = Number(request.headers.get("content-length") || 0);
  if (contentLength > 64 * 1024) throw new HttpError(413, "Corpo da requisição excede o limite.");
  try { return await request.json(); }
  catch { throw new HttpError(400, "JSON inválido."); }
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
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
  const endsAtMinute = startsAtMinute + calculation.durationMinutes;
  const now = saoPauloNow();
  if (date < now.date || (date === now.date && startsAtMinute < now.minute + config.minimumLeadMinutes)) throw new HttpError(422, "A antecedência mínima não foi respeitada.");
  if (startsAtMinute < config.opensAtMinute || endsAtMinute > config.closesAtMinute || startsAtMinute % config.slotIntervalMinutes !== 0) throw new HttpError(422, "Horário fora do expediente.");
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

function log(level, event, fields = {}) {
  const record = JSON.stringify({ event, ...fields });
  if (level === "error") console.error(record); else console.log(record);
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
      return json({ error: "not_found" }, 404, cors);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof HttpError ? error.message : "Não foi possível concluir a operação.";
      if (status >= 500) log("error", "request_failed", { path: url.pathname, message: error instanceof Error ? error.message : String(error) });
      return json({ error: message }, status, cors);
    }
  },
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(env.DB.prepare("UPDATE slot_holds SET status = 'expired', updated_at = CURRENT_TIMESTAMP WHERE status = 'active' AND expires_at <= CURRENT_TIMESTAMP").run());
  },
};
