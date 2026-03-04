-- Phase 3: Job credential containment
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS required_credential_ids JSONB DEFAULT '[]';

-- Phase 1 fixes: NOT NULL constraints (backfill then alter)
UPDATE credential_grants SET granted_by = 'system' WHERE granted_by IS NULL;
ALTER TABLE credential_grants ALTER COLUMN granted_by SET NOT NULL;

UPDATE credential_audit_log SET credential_name = 'unknown' WHERE credential_name IS NULL;
ALTER TABLE credential_audit_log ALTER COLUMN credential_name SET NOT NULL;

UPDATE credential_audit_log SET accessed_by = 'system' WHERE accessed_by IS NULL;
ALTER TABLE credential_audit_log ALTER COLUMN accessed_by SET NOT NULL;
