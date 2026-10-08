import { createPool, migrate, ownerUrl } from "../src/index";

const pool = createPool(ownerUrl());
try {
  const applied = await migrate(pool);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
} finally {
  await pool.end();
}
