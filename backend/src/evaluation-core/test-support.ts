import type { Count } from './contract.js'

/** The count without its scope, for assertions where the scope is not the
 * subject. Every count carries a scope by design — a bare figure is exactly what
 * the type refuses to hand out — so tests that are about accuracy and value say
 * so explicitly here rather than repeating an irrelevant scope in each one.
 *
 * Scope is asserted directly in the tests that are about scope. If this helper
 * ever became the only way counts were read in tests, the scope would be
 * effectively untested, so it is deliberately narrow. */
export const figure = (count: Count): Readonly<{ accuracy: Count['accuracy']; value: number | null }> =>
  ({ accuracy: count.accuracy, value: count.value })
