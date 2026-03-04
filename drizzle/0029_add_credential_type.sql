ALTER TABLE credentials ADD COLUMN type TEXT NOT NULL DEFAULT 'token';
--> statement-breakpoint
ALTER TABLE credentials ADD CONSTRAINT credentials_type_check CHECK (type IN ('token', 'oauth_client'));
