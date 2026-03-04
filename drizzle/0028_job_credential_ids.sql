ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "required_credential_ids" JSONB DEFAULT '[]';
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'credential_audit_log') THEN
    ALTER TABLE "credential_audit_log" DROP CONSTRAINT IF EXISTS "credential_audit_log_action_check";
    ALTER TABLE "credential_audit_log" ADD CONSTRAINT "credential_audit_log_action_check"
      CHECK (action IN ('read','create','update','delete','grant','revoke','use','expired_access_attempt'));
  END IF;
END $$;
