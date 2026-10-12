ALTER TABLE "mcp_servers" ADD COLUMN "denied_tools" jsonb DEFAULT '[]'::jsonb NOT NULL;
