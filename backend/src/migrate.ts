import "dotenv/config";
import { closeDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";

try {
  await migrate();
  console.log("Database migrations are up to date.");
} finally {
  await closeDatabase();
}
