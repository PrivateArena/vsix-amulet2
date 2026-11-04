/**
 * Where pi's packages come from, in the words the Packages dialog uses.
 *
 * The source formats are pi's own (`pi install --help`, `docs/packages.md`), listed once here so the
 * install form and the Discover tab cannot drift from each other or from what the host will accept.
 */

/** pi's package gallery, which is where a human looks when the search box is not enough. */
export const PI_PACKAGES_URL = 'https://pi.dev/packages';

export interface PackageSourceFormat {
  /** A copy-pasteable example, in the shape pi parses. */
  example: string;
  hint: string;
}

export const PACKAGE_SOURCE_FORMATS: PackageSourceFormat[] = [
  { example: 'npm:pi-mcp-extension', hint: 'npm package, optionally @1.2.3' },
  {
    example: 'git:github.com/owner/repo',
    hint: 'git repository, optionally @ref',
  },
  { example: './packages/my-pi-package', hint: 'folder on disk' },
];

/**
 * Why a typed source will not do, or null when it will.
 *
 * Shared because both sides must agree: the dialog must not offer a source the host will refuse, and
 * the host must not spawn a child for one it already knows is bad. Only the leading `-` is refused —
 * argv already carries a spaced path safely (no shell is involved), but `pi install -l` would read such
 * a source as one of its own flags.
 */
export function validatePackageSource(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed) return 'Enter a package source, e.g. npm:pi-mcp-extension.';
  if (trimmed.startsWith('-')) {
    return 'A package source cannot start with "-"; pi would read it as one of its own flags.';
  }
  return null;
}
