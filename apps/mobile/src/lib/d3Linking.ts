/**
 * The fork's deep-link schemes, added to upstream's linking options at the point
 * of use so upstream's own list stays as upstream wrote it.
 *
 * Each channel of the fork registers its own URL scheme (see d3.config.ts), and
 * pairing opens the app through that scheme. Upstream's schemes stay in the list
 * so a link made for T3 Code still opens this app.
 */
const D3_LINKING_PREFIXES = ["d3code://", "d3code-dev://", "d3code-preview://"] as const;

export function withD3Linking<T extends { readonly prefixes: readonly string[] }>(linking: T): T {
  return { ...linking, prefixes: [...linking.prefixes, ...D3_LINKING_PREFIXES] };
}
