import { appUrl, createPool, type Pool } from "@bos/db/runtime";

const globalForPool = globalThis as unknown as { bosPool?: Pool };

/** One connection pool per server process, as the restricted app role. */
export const pool: Pool = globalForPool.bosPool ?? (globalForPool.bosPool = createPool(appUrl()));
