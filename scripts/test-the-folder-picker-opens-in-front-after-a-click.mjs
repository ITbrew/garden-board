/**
 * The folder picker ends up on top of the browser even when the owner has just clicked the browser.
 * Canon 02 revision 16.
 *
 * `test-the-folder-picker-opens-in-front.mjs` passed while the owner's + tab kept putting the picker
 * behind Garden: "when u do it, the window opens up, when i press plus it goes behind garden app".
 * The difference is his click. A window that has just had real input is guarded by Windows, and every
 * attempt to take the foreground from it was refused (the raise log from his click: fifteen tries,
 * front=False, Chrome still in front). A pick sent from a script, with nobody clicking, never meets
 * that guard, so that test could not see the failure.
 *
 * So this one clicks. It opens a throwaway Chrome window of its own, moves the real mouse onto it and
 * clicks with a real input event, then asks its own Garden for a pick, exactly as the + tab does after
 * a click. What is checked is what he sees: which window is actually on top at the centre of the
 * picker, not which one Windows calls the foreground.
 *
 * This moves the mouse, opens a window and a dialog for a few seconds and closes both, so it is not in
 * the suite: run it by hand. Its own Garden on its own port.
 */
import WebSocket from 'ws'
import { execFileSync, spawn } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

const SIG = String.raw`
$sig = @"
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
[DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
[DllImport("user32.dll")] public static extern void mouse_event(uint f, int x, int y, uint d, UIntPtr e);
[DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
[DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint c);
[DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
public struct RECT { public int L, T, R, B; }
public struct POINT { public int X, Y; }
"@
$api = Add-Type -MemberDefinition $sig -Name T -Namespace PickClick -PassThru | Where-Object { $_.Name -eq 'T' }
`
const ps = (body, env = {}) =>
  String(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', SIG + body], {
      env: { ...process.env, ...env },
      windowsHide: true,
    }),
  ).trim()

// A throwaway browser window with a title this test can find, in a profile of its own.
const TITLE = 'Garden picker click target'
const profile = mkdtempSync(join(tmpdir(), 'garden-pick-click-chrome-'))
const chrome = spawn(
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  [
    `--app=data:text/html,<title>${encodeURIComponent(TITLE)}</title><body style="background:%23234">click target</body>`,
    `--user-data-dir=${profile}`,
    // Maximized, as the owner's Garden window is.
    '--start-maximized',
    '--no-first-run',
    '--no-default-browser-check',
  ],
  { stdio: 'ignore' },
)
let target = ''
for (let i = 0; i < 40 && !target; i++) {
  await sleep(250)
  target = ps(`$h = $api::FindWindow('Chrome_WidgetWin_1', '${TITLE}'); if ($h -ne [IntPtr]::Zero) { [string]$h }`)
}
check('the click target window opened', !!target)
// Maximizing lands after the window first exists; a click before it can miss.
await sleep(2000)

const inst = await startInstance({ entry: 'tsx' })
const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/ws`)
const replies = []
ws.on('message', (raw) => replies.push(JSON.parse(String(raw))))
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)

// A real click on the browser window, then the pick straight after, as the + tab sends it.
const cursor = ps(`$p = New-Object PickClick.T+POINT; [void]$api::GetCursorPos([ref]$p); "$($p.X),$($p.Y)"`)
const clicked = ps(
  `$h = [IntPtr][long]$env:TARGET; $r = New-Object PickClick.T+RECT; [void]$api::GetWindowRect($h, [ref]$r)
  [void]$api::SetCursorPos([int](($r.L + $r.R) / 2), [int](($r.T + $r.B) / 2)); Start-Sleep -Milliseconds 150
  $api::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); $api::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 300
  $api::GetForegroundWindow() -eq $h`,
  { TARGET: target },
)
check('the browser window had a real click and is in front', clicked === 'True', clicked)
ws.send(JSON.stringify({ t: 'project.pick' }))

// Wait out the picker's start and the raise helper's own budget, then look at what is on top.
let seen = null
for (let i = 0; i < 40; i++) {
  await sleep(250)
  const out = ps(
    `$d = $api::FindWindow('#32770', 'Pick a project folder for Garden'); if ($d -eq [IntPtr]::Zero) { 'NONE'; exit }
    $r = New-Object PickClick.T+RECT; [void]$api::GetWindowRect($d, [ref]$r)
    $p = New-Object PickClick.T+POINT; $p.X = [int](($r.L + $r.R) / 2); $p.Y = [int](($r.T + $r.B) / 2)
    $top = $api::GetAncestor($api::WindowFromPoint($p), 2)
    $pp = [uint32]0; [void]$api::GetWindowThreadProcessId($d, [ref]$pp); $tp = [uint32]0; [void]$api::GetWindowThreadProcessId($top, [ref]$tp)
    @{ onTop = ($pp -eq $tp); fg = ($api::GetForegroundWindow() -eq $d); owned = ($api::GetWindow($d, 4) -ne [IntPtr]::Zero); at = "$($r.L),$($r.T)" } | ConvertTo-Json -Compress`,
  )
  if (out !== 'NONE') seen = JSON.parse(out)
  if (seen && i >= 24) break
}
check('the picker opened', !!seen, JSON.stringify(seen))
check('after a click on the browser, the picker is the window on top where it sits', !!seen?.onTop, JSON.stringify(seen))

// Close the picker and the window, and put the mouse back where it was.
ps(`$d = $api::FindWindow('#32770', 'Pick a project folder for Garden'); if ($d -ne [IntPtr]::Zero) { [void]$api::PostMessage($d, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
[void]$api::SetCursorPos(${cursor.split(',').map(Number).join(', ')})`)
await sleep(1500)
const picked = replies.find((m) => m.t === 'project.picked')
check('closing it ends the pick as a cancel', picked?.path === null, JSON.stringify(picked ?? null))
chrome.kill()
ws.close()
await inst.stop()
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
