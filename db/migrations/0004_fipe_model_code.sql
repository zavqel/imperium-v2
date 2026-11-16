ALTER TABLE vehicle_models ADD COLUMN fipe_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_vehicle_models_make_fipe_code
ON vehicle_models(make_id, fipe_code)
WHERE fipe_code IS NOT NULL;
