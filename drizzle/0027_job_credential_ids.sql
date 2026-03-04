ALTER TABLE "jobs" ADD COLUMN "required_credential_ids" JSONB DEFAULT '[]';

ALTER TABLE "credential_audit_log" DROP CONSTRAINT IF EXISTS "credential_audit_log_action_check";
ALTER TABLE "credential_audit_log" ADD CONSTRAINT "credential_audit_log_action_check"
  CHECK (action IN ('read','create','update','delete','grant','revoke','use','expired_access_attempt'));
