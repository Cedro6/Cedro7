/**
 * Who runs the service. Their emails are listed in PLATFORM_ADMIN_EMAILS (comma separated) in the
 * hosting settings. With nothing listed, nobody is: the platform screen does not exist for anyone.
 */
export function isPlatformAdmin(email: string | undefined): boolean {
  if (!email) return false;
  const listed = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  return listed.includes(email.toLowerCase());
}
