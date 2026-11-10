// Renders function components eagerly so tests can walk the resulting tree.
export function jsx(type: unknown, props: Record<string, unknown> = {}): unknown {
  if (typeof type === 'function') return (type as (p: unknown) => unknown)(props)
  return { type, props }
}
export const jsxs = jsx
