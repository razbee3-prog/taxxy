import { connectSurreal } from "../client.js";
import { dbConfigFromEnv } from "../config.js";
import { migrate } from "../migrate.js";

const cfg = dbConfigFromEnv();
const db = await connectSurreal(cfg.app);
const ran = await migrate(db);
console.log(ran.length ? `applied: ${ran.join(", ")}` : "schema up to date");
await db.close();
