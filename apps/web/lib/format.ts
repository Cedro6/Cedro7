const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

export function formatMoney(value: number): string {
  return money.format(value);
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
}
