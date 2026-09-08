import { createAiPlatformConnection } from "./connection.js";
import { migrateAiPlatformDatabase } from "./migrate.js";

export function openAiPlatformDatabase(databasePath, options = {}) {
  const db = createAiPlatformConnection(databasePath);
  try {
    migrateAiPlatformDatabase(db, options);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export { migrateAiPlatformDatabase };
