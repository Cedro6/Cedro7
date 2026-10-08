import { createPool, ownerUrl, seed } from "../src/index";

const pool = createPool(ownerUrl());
try {
  const { orgId } = await seed(pool);
  console.log(`Demo company ready (org ${orgId}).`);
} finally {
  await pool.end();
}
