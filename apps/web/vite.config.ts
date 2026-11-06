import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/*
 * The open page never changes under the owner. Canon 22 revision 10.
 *
 * This dev server is his page, served from the checkout the cards edit, and a hot update pushed each
 * saved file into it on the spot. A save to `preview.ts` swapped a fresh copy of `state.ts`, the store
 * and the socket, into the running page with nothing feeding it, and his board read offline with no
 * cards until he pressed F5: "its really annoying when resets happen and im left hung like that". So
 * an update is dropped here and the change reaches him at the next page load, which Restart server
 * brings. The client stays connected, which is what reloads the page when this server restarts.
 * `GARDEN_HMR=1` restores hot updates for a Vite someone starts by hand to develop against.
 */
const holdHotUpdates: Plugin = {
  name: 'garden-hold-hot-updates',
  apply: 'serve',
  handleHotUpdate() {
    return process.env.GARDEN_HMR === '1' ? undefined : []
  },
}

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
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
/*
 * HEAD from the repository's own files, the same way the server reads it (server/src/build.ts), so the
 * two halves can never disagree because git was slow for one of them during a restart.
 */
const commit = (() => {
  let head: string | null = null
  try {
    const text = readFileSync(join(repo, '.git', 'HEAD'), 'utf8').trim()
    if (!text.startsWith('ref: ')) head = /^[0-9a-f]{7,}$/.test(text) ? text.slice(0, 7) : null
    else {
      const ref = text.slice(5)
      const loose = join(repo, '.git', ...ref.split('/'))
      if (existsSync(loose)) head = readFileSync(loose, 'utf8').trim().slice(0, 7)
      else head = readFileSync(join(repo, '.git', 'packed-refs'), 'utf8').split(/\r?\n/).find((l) => l.endsWith(' ' + ref))?.slice(0, 7) ?? null
    }
  } catch {
    head = null
  }
  if (!head) return 'nocommit'
  try {
    const dirty = execFileSync('git', ['status', '--porcelain'], { cwd: repo, encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim()
    return dirty.length > 0 ? head + '+' : head
  } catch {
    return head
  }
})()

export default defineConfig({
  plugins: [react(), holdHotUpdates],
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
    /*
     * 5177 unless told otherwise, and the telling matters more than the default.
     *
     * This was the literal 5177, which made `npm run dev:web` a command that always took the
     * owner's page port no matter who ran it or why. The restart helper starts the page half with
     * exactly that command, so `--web-port` made the KILL targeted while the START stayed aimed at
     * 5177: a restart told to replace a page half on some other port would stop that one and then
     * raise a Vite on the owner's. Measured on the other PC on 2026-09-18, where a suite test's
     * restart spawned `npm run dev -w @garden/web` and a new Vite appeared on 5177 while the owner
     * was using it.
     *
     * `scripts/launch.ps1` already sets GARDEN_WEB_PORT for the real board, so the board's behaviour
     * is unchanged. What changes is that an instance a test starts can now be told to keep its
     * hands off 5177, and be believed.
     */
    port: Number(process.env.GARDEN_WEB_PORT) || 5177,
    strictPort: true,
  },
})
