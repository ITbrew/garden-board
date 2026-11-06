/**
 * The version string Vite substitutes at build time, from `apps/web/package.json`.
 *
 * A declaration rather than a real module because there is nothing to import: `vite.config.ts`
 * replaces the identifier with a literal before TypeScript's output is ever run. This file exists
 * so the compiler knows the name is legal, and it has to say `const` so nothing tries to assign to
 * something that will not exist at runtime.
 */
declare const __GARDEN_VERSION__: string
/**
 * The commit the page was built from, with a trailing '+' when the checkout was dirty, or
 * 'nocommit' when git could not be asked. Substituted the same way and for the same reason.
 */
declare const __GARDEN_BUILD__: string
