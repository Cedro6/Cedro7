const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(value: number): string {
  return money.format(value);
}

const qty = new Intl.NumberFormat("en-US", { maximumFractionDigits: 4 });

export function formatQty(value: number): string {
  return qty.format(value);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}

/** A default profile picture: a vivid gradient picked from the name, so each person or company keeps the same one. */
export function avatarGradient(name: string): string {
  let h = 2166136261;
  for (const ch of name) h = Math.imul(h ^ ch.charCodeAt(0), 16777619);
  h ^= h >>> 15;
  h = Math.imul(h, 2246822519);
  h ^= h >>> 13;
  h = Math.imul(h, 3266489917);
  h = (h ^ (h >>> 16)) >>> 0;
  const a = h % 360;
  const b = (a + 110 + ((h >> 9) % 60)) % 360;
  const c = (a + 220 + ((h >> 5) % 50)) % 360;
  const angle = (h >> 4) % 360;
  return `radial-gradient(circle at ${20 + ((h >> 7) % 40)}% ${15 + ((h >> 11) % 35)}%, hsl(${a} 100% 74%), transparent 58%), linear-gradient(${angle}deg, hsl(${b} 95% 58%), hsl(${c} 90% 46%))`;
}
