import { app, closeDatabase } from "./app.js";
import { config } from "./config.js";

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
