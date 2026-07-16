import { main } from "../src/scripts/pronoun-audit.js";

main(process.argv.slice(2)).catch((error) => {
  console.error("Script failed:", error);
  process.exit(1);
});
