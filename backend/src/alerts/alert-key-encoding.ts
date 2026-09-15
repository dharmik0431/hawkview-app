/** How a key is built from components that came from somewhere else.
 *
 * Every alerting key — the event key, and the incident key that will sit beside
 * it — is a tuple of variable-length strings that HawkView did not choose:
 * organization ids, tenant ids, Microsoft audit ids, resource names. Turning a
 * tuple into a string is the part that looks trivial and is not.
 *
 * A plain `a:b:c` join is ambiguous the moment any component may contain the
 * separator. Organization `x:y` with tenant `z` and organization `x` with tenant
 * `y:z` produce the identical string, which is two different tuples sharing one
 * key. In an idempotency key that is a cross-tenant collision, and its symptom is
 * a real alert silently suppressed in one organization because an unrelated event
 * was seen in another — not an error anybody would see, and not something that
 * shows up in a test written from the happy path.
 *
 * This lives on its own rather than inside either key because both need it and a
 * copied security primitive is the arrangement that decays: one copy gets fixed.
 */

/** Length-prefixes each component, so no component's content can move a boundary.
 *
 * `['x:y', 'z']` encodes as `3:x:y1:z` and `['x', 'y:z']` as `1:x3:y:z`. The
 * encoding is prefix-free: a reader takes digits up to the first `:`, then
 * exactly that many characters, so the content that follows cannot be mistaken
 * for structure. A component that itself LOOKS like a prefix (`2:ab`) is counted,
 * not parsed, so it cannot fake one either.
 *
 * Lengths are UTF-16 code units, which is what `String.length` gives and what a
 * decoder slicing the same string would consume. The two agree, so a component
 * holding an emoji or a non-Latin tenant name is encoded and delimited correctly
 * even though its code-unit length is not its character count.
 */
export function joinUnambiguously(parts: readonly string[]): string {
  return parts.map((part) => `${part.length}:${part}`).join('')
}
