-- Drop the legacy model_catalog_selections table (dead code; model resolution
-- now uses the settings row then LAST_RESORT_MODELS; App Home uses the full
-- synced model_catalog directly).
DROP TABLE IF EXISTS "model_catalog_selections";--> statement-breakpoint
DROP TYPE IF EXISTS "model_catalog_category";
