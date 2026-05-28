import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CORPUS_DIR = __dirname;
export const CACHE_DIR = join(CORPUS_DIR, "cache");
