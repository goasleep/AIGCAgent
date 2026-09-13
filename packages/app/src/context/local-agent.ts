export function hasCustomAgent(items: Array<{ native?: boolean }>) {
  return items.some((item) => item.native === false)
}

export function resolveAgent<T extends { name: string }>(items: T[], name?: string) {
  // Media Studio: creator is the product-facing default; build is hidden (architecture §5.5)
  return items.find((item) => item.name === name) ?? items.find((item) => item.name === "creator") ?? items[0]
}
