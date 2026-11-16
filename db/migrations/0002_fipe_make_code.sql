
ALTER TABLE vehicle_makes
ADD COLUMN fipe_code TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS
idx_vehicle_makes_fipe_code
ON vehicle_makes(fipe_code)
WHERE fipe_code IS NOT NULL;
