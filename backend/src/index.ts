import "dotenv/config";
import { app } from "./app.js";
import { closeDatabase } from "./db/index.js";
import { migrate } from "./db/migrate.js";
import { config } from "./config.js";

await migrate();

const server = app.listen(config.PORT, () => {
  console.log(`GuildHall API listening on :${config.PORT}`);
});

async function shutdown() {
  server.close(async () => {
    await closeDatabase();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
