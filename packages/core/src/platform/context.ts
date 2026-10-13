import type { Pool } from "@bos/db/runtime";
import type { FeatureSet } from "./features";
import type { Role } from "./permissions";

/** Who is acting, for which company. Every service function takes one. */
export type Ctx = {
  pool: Pool;
  orgId: string;
  userId: string;
  role: Role;
  /** The company's feature switches. Left out, every feature counts as on. */
  features?: FeatureSet;
  /** The company's time zone, such as "Europe/London". Left out, Eastern time. */
  timeZone?: string;
  /** The company's currency code. Left out, US dollars. */
  currency?: string;
};
