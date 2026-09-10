import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * The version the header shows, read from this package rather than typed into the interface.
 *
 * Two places holding the same number is how a header ends up claiming a release the code is not.
 * `npm version` moves this one and the header follows, and there is nothing to remember.
 */
const version = JSON.parse(
  readFileSync(fileURLToPath(new URL('./package.json', import.meta.url)), 'utf8'),
).version as string

/*
 * The commit this page was built from, and a mark when the checkout had uncommitted changes.
 *
 * The version answers "which release", which is what the owner reads. This answers "which build",
 * which is what tells the two halves apart between releases: the server records the same pair when
 * it starts, and the header says so when they do not match. Read once, when the config loads, so
 * what it names is the build rather than the checkout as it is now.
 *
 * Never fatal. A missing git, or a checkout that is not a repository, gives 'nocommit' and the page
 * still builds. A build label is not worth refusing to build over.
 */
const commit = (() => {
  const git = (args: string[]) =>
    execFileSync('git', args, { encoding: 'utf8', timeout: 4000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  try {
    const head = git(['rev-parse', '--short', 'HEAD'])
    return git(['status', '--porcelain']).length > 0 ? head + '+' : head
  } catch {
    return 'nocommit'
  }
})()

export default defineConfig({
  plugins: [react()],
  define: {
    __GARDEN_VERSION__: JSON.stringify(version),
    __GARDEN_BUILD__: JSON.stringify(commit),
  },
  resolve: {
    alias: {
      // @xterm/headless 6.0.0 ships a package.json whose "module" field points at
      // lib/xterm.mjs, which is not in the tarball. Point at the ESM build that is actually
      // published, or Vite fails to resolve the package entry at all.
      '@xterm/headless': '@xterm/headless/lib-headless/xterm-headless.mjs',
    },
  },
  server: {
    // Bind IPv4 explicitly. Vite's default resolves to [::1] only on this machine, so anything
    // checking 127.0.0.1 (the launcher, curl, a health probe) sees a closed port and concludes
    // the UI never started.
    host: '127.0.0.1',
    port: 5177,
    strictPort: true,
  },
})
