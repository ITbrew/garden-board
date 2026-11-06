/**
 * Proves the + tab's folder picker opens in front of everything, with a taskbar button of its own.
 *
 * The owner: "the open project file explorer needs to goto front of screen, its hidden behind
 * garden". The old picker was owned by an invisible form with no taskbar button, and the server is a
 * background process Windows refuses the foreground to, so it opened behind the browser and waited
 * there unseen. Canon 02 revision 11.
 *
 * This opens a real dialog on the desktop for a few seconds, then closes it, so it is not in the
 * suite: run it by hand. It uses its own instance, so the owner's board is never asked to pick.
 */
import WebSocket from 'ws'
import { execFileSync } from 'node:child_process'
import { startInstance } from './lib/instance.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let failures = 0
const check = (n, ok, d = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${n}${d ? '  -- ' + d : ''}`)
  if (!ok) failures++
}

// Reads the desktop from outside Garden: the picker window (a #32770 whose title is ours), whether
// it is the foreground window, whether it is an unowned top-level window (which is what earns a
// taskbar button), and its class and size. Prints one JSON line, or NONE.
const probe = String.raw`
$sig = @"
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr FindWindow(string c, string t);
[DllImport("user32.dll")] public static extern IntPtr GetWindow(IntPtr h, uint cmd);
[DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
[DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
[DllImport("user32.dll")] public static extern IntPtr PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
public struct RECT { public int L, T, R, B; }
"@
$api = Add-Type -MemberDefinition $sig -Name Probe -Namespace GardenTest -PassThru | Where-Object { $_.Name -eq 'Probe' }
$h = $api::FindWindow('#32770', 'Pick a project folder for Garden')
if ($h -eq [IntPtr]::Zero) { 'NONE'; exit }
$r = New-Object GardenTest.Probe+RECT
[void]$api::GetWindowRect($h, [ref]$r)
$o = @{ fg = ($api::GetForegroundWindow() -eq $h); visible = $api::IsWindowVisible($h); owned = ($api::GetWindow($h, 4) -ne [IntPtr]::Zero); w = $r.R - $r.L; h = $r.B - $r.T }
if ($env:CLOSE_IT) { [void]$api::PostMessage($h, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) }
$o | ConvertTo-Json -Compress
`
const look = (close = false) =>
  String(
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], {
      env: { ...process.env, ...(close ? { CLOSE_IT: '1' } : {}) },
      windowsHide: true,
    }),
  ).trim()

const inst = await startInstance({ entry: 'tsx' })
const ws = new WebSocket(`ws://127.0.0.1:${inst.port}/ws`)
const replies = []
ws.on('message', (raw) => replies.push(JSON.parse(String(raw))))
await new Promise((r) => ws.on('open', r))
ws.send(JSON.stringify({ t: 'hello' }))
await sleep(500)
ws.send(JSON.stringify({ t: 'project.pick' }))

// The picker compiles its COM declarations first, and the raise helper retries for four seconds.
let seen = 'NONE'
for (let i = 0; i < 40 && (seen === 'NONE' || !JSON.parse(seen).fg || !JSON.parse(seen).visible); i++) {
  await sleep(250)
  seen = look()
}
const w = seen === 'NONE' ? null : JSON.parse(seen)
check('the picker opens', !!w?.visible, seen)
check('it is the Explorer-style picker, not the old tree box', !!w && w.w > 600 && w.h > 400, w ? `${w.w}x${w.h}` : '')
check('it is in front of everything', !!w?.fg)
check('it is owned by the picker’s own always-on-top window, which carries the taskbar button', w != null && w.owned)

look(true)
await sleep(1500)
const picked = replies.find((m) => m.t === 'project.picked')
check('closing it ends the pick, as a cancel', picked?.path === null, JSON.stringify(picked ?? null))
check(
  'and says nothing about it',
  !replies.some((m) => m.t === 'error'),
  replies.filter((m) => m.t === 'error').map((m) => m.message).join('; '),
)

ws.close()
await inst.stop()
console.log(failures ? `\n${failures} FAILED` : '\nALL PASS')
process.exit(failures ? 1 : 0)
