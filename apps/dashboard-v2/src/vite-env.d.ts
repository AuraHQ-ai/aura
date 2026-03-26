interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  readonly VITE_API_SECRET: string;
  readonly VITE_SESSION_SECRET: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare module "*.css" {}
