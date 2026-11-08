PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS vehicle_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicle_makes (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  normalized_name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS vehicle_models (
  id INTEGER PRIMARY KEY,
  make_id INTEGER NOT NULL REFERENCES vehicle_makes(id),
  vehicle_category_id INTEGER NOT NULL REFERENCES vehicle_categories(id),
  name TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (make_id, normalized_name)
);
CREATE INDEX IF NOT EXISTS idx_vehicle_models_make_active ON vehicle_models(make_id, active, normalized_name);

CREATE TABLE IF NOT EXISTS service_categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS services (
  id INTEGER PRIMARY KEY,
  service_category_id INTEGER REFERENCES service_categories(id),
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  short_description TEXT,
  full_description TEXT,
  image_key TEXT,
  pricing_mode TEXT NOT NULL DEFAULT 'vehicle_category' CHECK (pricing_mode IN ('vehicle_category', 'fixed')),
  fixed_price_cents INTEGER CHECK (fixed_price_cents IS NULL OR fixed_price_cents >= 0),
  duration_minutes INTEGER NOT NULL CHECK (duration_minutes > 0),
  last_start_minute INTEGER CHECK (last_start_minute IS NULL OR (last_start_minute >= 0 AND last_start_minute < 1440)),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_services_active_category ON services(active, service_category_id, sort_order);

CREATE TABLE IF NOT EXISTS addons (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  description TEXT,
  image_key TEXT,
  pricing_mode TEXT NOT NULL DEFAULT 'fixed' CHECK (pricing_mode IN ('fixed', 'vehicle_category')),
  fixed_price_cents INTEGER CHECK (fixed_price_cents IS NULL OR fixed_price_cents >= 0),
  duration_minutes INTEGER NOT NULL DEFAULT 0 CHECK (duration_minutes >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS service_addon_compatibility (
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  addon_id INTEGER NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  PRIMARY KEY (service_id, addon_id)
);

CREATE TABLE IF NOT EXISTS category_service_prices (
  vehicle_category_id INTEGER NOT NULL REFERENCES vehicle_categories(id),
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (vehicle_category_id, service_id)
);

CREATE TABLE IF NOT EXISTS category_addon_prices (
  vehicle_category_id INTEGER NOT NULL REFERENCES vehicle_categories(id),
  addon_id INTEGER NOT NULL REFERENCES addons(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  PRIMARY KEY (vehicle_category_id, addon_id)
);

CREATE TABLE IF NOT EXISTS model_service_price_overrides (
  vehicle_model_id INTEGER NOT NULL REFERENCES vehicle_models(id),
  service_id INTEGER NOT NULL REFERENCES services(id) ON DELETE CASCADE,
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  PRIMARY KEY (vehicle_model_id, service_id)
);

CREATE TABLE IF NOT EXISTS discount_rules (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  minimum_cents INTEGER NOT NULL CHECK (minimum_cents >= 0),
  percent_basis_points INTEGER NOT NULL CHECK (percent_basis_points BETWEEN 0 AND 10000),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  starts_at TEXT,
  ends_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_discount_rules_active_minimum ON discount_rules(active, minimum_cents DESC);

CREATE TABLE IF NOT EXISTS business_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS operating_hours (
  weekday INTEGER PRIMARY KEY CHECK (weekday BETWEEN 0 AND 6),
  opens_at_minute INTEGER NOT NULL CHECK (opens_at_minute BETWEEN 0 AND 1439),
  closes_at_minute INTEGER NOT NULL CHECK (closes_at_minute BETWEEN 1 AND 1440),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  CHECK (closes_at_minute > opens_at_minute)
);

CREATE TABLE IF NOT EXISTS schedule_blackouts (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  starts_at_minute INTEGER NOT NULL CHECK (starts_at_minute BETWEEN 0 AND 1439),
  ends_at_minute INTEGER NOT NULL CHECK (ends_at_minute BETWEEN 1 AND 1440),
  reason TEXT,
  CHECK (ends_at_minute > starts_at_minute)
);
CREATE INDEX IF NOT EXISTS idx_schedule_blackouts_date ON schedule_blackouts(date, starts_at_minute);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (phone)
);

CREATE TABLE IF NOT EXISTS customer_vehicles (
  id INTEGER PRIMARY KEY,
  customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
  vehicle_model_id INTEGER NOT NULL REFERENCES vehicle_models(id),
  display_name TEXT NOT NULL,
  plate TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS slot_holds (
  id TEXT PRIMARY KEY,
  date TEXT NOT NULL,
  starts_at_minute INTEGER NOT NULL,
  ends_at_minute INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'expired', 'released')),
  expires_at TEXT NOT NULL,
  quote_snapshot TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at_minute > starts_at_minute)
);
CREATE INDEX IF NOT EXISTS idx_slot_holds_status_expiry ON slot_holds(status, expires_at);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  hold_id TEXT UNIQUE REFERENCES slot_holds(id),
  customer_id INTEGER REFERENCES customers(id),
  vehicle_model_id INTEGER REFERENCES vehicle_models(id),
  vehicle_label TEXT NOT NULL,
  date TEXT NOT NULL,
  starts_at_minute INTEGER NOT NULL,
  ends_at_minute INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('awaiting_payment', 'confirmed', 'in_progress', 'completed', 'cancelled', 'payment_issue')),
  subtotal_cents INTEGER NOT NULL,
  discount_cents INTEGER NOT NULL DEFAULT 0,
  total_cents INTEGER NOT NULL,
  paid_cents INTEGER NOT NULL DEFAULT 0,
  balance_cents INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CHECK (ends_at_minute > starts_at_minute)
);
CREATE INDEX IF NOT EXISTS idx_bookings_date_status ON bookings(date, status, starts_at_minute);

CREATE TABLE IF NOT EXISTS booking_items (
  id INTEGER PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  item_kind TEXT NOT NULL CHECK (item_kind IN ('service', 'addon')),
  source_id INTEGER NOT NULL,
  name_snapshot TEXT NOT NULL,
  unit_price_cents INTEGER NOT NULL,
  duration_minutes INTEGER NOT NULL,
  pricing_source TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  provider TEXT NOT NULL DEFAULT 'mercado_pago',
  provider_payment_id TEXT UNIQUE,
  idempotency_key TEXT NOT NULL UNIQUE,
  mode TEXT NOT NULL CHECK (mode IN ('full', 'reservation')),
  amount_cents INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'cancelled', 'expired', 'refunded')),
  expires_at TEXT,
  approved_at TEXT,
  raw_status TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_payments_booking ON payments(booking_id, status);

CREATE TABLE IF NOT EXISTS webhook_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  provider_event_id TEXT NOT NULL,
  received_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  processed_at TEXT,
  payload TEXT NOT NULL,
  UNIQUE (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS admin_users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('owner', 'admin', 'operator')),
  active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id INTEGER PRIMARY KEY,
  actor_user_id INTEGER REFERENCES admin_users(id),
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  before_state TEXT,
  after_state TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
