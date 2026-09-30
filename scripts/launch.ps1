# Garden launcher.
#
# Starts whichever halves are not already up, waits for them to answer, then opens the app in its
# own Chrome window. Safe to run twice: it reuses what is already running rather than starting a
# second copy, and safe to run when half of it is up, which is the state it used to give up on.
#
# The shortcut runs this with -WindowStyle Hidden, and that is the fact that governs the whole file.
# There is no console to write to and no console to read from. Every message therefore goes through
# Say/Ask, which put a real dialog on screen, and nothing in here ever calls Read-Host or Write-Host
# expecting a person to see it. The previous version did both: it printed a diagnosis nobody could
# read and then blocked on Read-Host forever, so double-clicking the shortcut appeared to do nothing
# at all and quietly left a stuck powershell.exe behind every time. Five of them had piled up before
# anyone noticed, which is exactly how long an invisible failure survives.

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms | Out-Null

$Root = Split-Path -Parent $PSScriptRoot
$LogDir = Join-Path $Root 'logs'
$WebPort = 5177
$ServerPort = 5178
$Url = "http://localhost:$WebPort/"
# Filled in by Start-Half with the path each half's errors really went to, and read by the failure
# messages. A half that was never started leaves no entry, which is what the fallbacks below cover.
$ErrLogs = @{}

<#
    A log of this script's own, written before anything else can fail.

    Every other log here belongs to a half this script starts. The launcher itself wrote nothing, so
    when it exited early it left no trace whatsoever, and "the shortcut does nothing" could not be
    told apart from "the shortcut was never clicked".

    That is not hypothetical. On 2026-09-18 the other PC established that no launch had reached
    Start-Half all day: dev-web.log was last rotated at 22:36 the previous night and every launch
    rotates it, so the owner's relaunches either never ran this file or exited before that point, and
    nothing on the machine could say which. PowerShell event logging is off, so there was nothing to
    fall back on.

    One line per decision, appended, never rotated. It is a few hundred bytes a launch and the
    previous run's trace is the thing most worth having. Every failure is swallowed on purpose: a log
    that cannot be written must never be the reason a launch dies, which is the exact bug that the
    rotation handling further down exists to fix.
#>
$LogFile = Join-Path $LogDir 'launch.log'
function Write-Log([string]$Line) {
    try {
        if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
        Add-Content -Path $LogFile -Encoding utf8 -ErrorAction Stop `
            -Value ("{0}  {1}" -f (Get-Date).ToString('yyyy-MM-dd HH:mm:ss'), $Line)
    } catch {
        # Deliberately empty. See above: never fail a launch over its own log.
    }
}

Write-Log ''
Write-Log ("LAUNCH  pid $PID  root $Root  web $WebPort  server $ServerPort")

<#
    An owner window, so a dialog from this script is not invisible.

    Say and Ask are the only reporting channels this file has, and under -WindowStyle Hidden they are
    raised by a process that has never received user input and whose parent console has exited.
    That process is refused SetForegroundWindow by Windows' foreground lock, which is measured and
    documented: it is the same lock that put the folder dialog behind the browser with no taskbar
    button, where it looked exactly like a click that did nothing. A launcher stopping on a question
    nobody can see is the same failure with worse consequences, because it stops the launch.

    A TopMost owner form fixes the half that can be fixed. WS_EX_TOPMOST is set when the window is
    created rather than asked for afterwards, so it is not subject to the refusal that
    SetWindowPos(HWND_TOPMOST) hits on an existing window, and a MessageBox owned by that form sits
    above ordinary windows.

    Honest about what it does not do: topmost is a z-order guarantee, not a focus one. The dialog can
    still come up without keyboard focus. It will be on screen, which is the part that was failing.
#>
function New-DialogOwner {
    $f = New-Object System.Windows.Forms.Form
    $f.TopMost = $true
    $f.ShowInTaskbar = $false
    $f.FormBorderStyle = 'None'
    $f.Opacity = 0
    $f.Width = 1
    $f.Height = 1
    $f.StartPosition = 'CenterScreen'
    $f.Show()
    $f.Activate()
    return $f
}

# One line, so a dialog that stopped a launch is legible in the log rather than reconstructed.
function Write-DialogLog([string]$Kind, [string]$Title, [string]$Message) {
    Write-Log ("$Kind [$Title] " + ($Message -replace "`r`n", ' / ' -replace "`n", ' / '))
}

<#
    Say what happened, in something the owner can actually see.

    A message box rather than the console, because the console does not exist under -WindowStyle
    Hidden. This is the only reporting channel this script has and every failure path uses it.
#>
function Say([string]$Message, [string]$Title = 'Garden', [string]$Icon = 'Information') {
    Write-DialogLog 'SAY' $Title $Message
    $owner = New-DialogOwner
    try {
        [System.Windows.Forms.MessageBox]::Show($owner, $Message, $Title, 'OK', $Icon) | Out-Null
    } finally {
        $owner.Close()
        $owner.Dispose()
    }
}

function Ask([string]$Message, [string]$Title = 'Garden') {
    Write-DialogLog 'ASK' $Title $Message
    $owner = New-DialogOwner
    try {
        $answer = [System.Windows.Forms.MessageBox]::Show($owner, $Message, $Title, 'YesNo', 'Question')
    } finally {
        $owner.Close()
        $owner.Dispose()
    }
    $yes = $answer -eq [System.Windows.Forms.DialogResult]::Yes
    Write-Log ("ANSWER [$Title] " + $(if ($yes) { 'Yes' } else { 'No' }))
    return $yes
}

<#
    The backstop: no error in this script is allowed to be invisible.

    $ErrorActionPreference is 'Stop', so any unhandled failure anywhere below ends the script, and
    with no console attached that ending has no symptom at all. A double-clicked shortcut that does
    nothing is indistinguishable from one that was never clicked, and it cost four clicks and a run
    from a real console to find out that the launcher had been dying on a locked log file.

    Specific failures are still reported specifically; the messages further down say what to do about
    a backend or a UI that will not come up. This only catches what nobody anticipated, and says
    where it happened, which is the least a launcher owes someone staring at an unchanged desktop.
#>
trap {
    Write-Log ("TRAP  " + $_.Exception.Message + "  at " +
        ($_.InvocationInfo.PositionMessage -replace "`r`n", ' ' -replace "`n", ' '))
    Say ("Garden could not be started.`n`n" +
        $_.Exception.Message + "`n" +
        $_.InvocationInfo.PositionMessage) 'Garden did not start' 'Error'
    Write-Log 'EXIT 1  unhandled error'
    exit 1
}

<#
    How Garden runs on this machine, asked once. Canon 01 revision 3.

    The owner: "fewer approval prompts and runs as admin", and "recommend new users to set it this way
    on first use". So the first launch, with no setup.json yet, asks, with yes recommended and the
    cost stated. Yes hands off to make-shortcut.ps1 -Elevated, which is where the one Windows prompt
    is, registers the task and rewrites the shortcut; the halves already up are stopped, because they
    were started without the rights and would keep running without them, and the task then launches
    everything again elevated.

    After that, a launch that is not elevated while the choice says it should be (an old shortcut, a
    run by hand) starts the task and leaves, so every way in ends up the same.
#>
$DataDir = if ($env:GARDEN_HOME) { $env:GARDEN_HOME } else { Join-Path $HOME '.garden' }
$SetupFile = Join-Path $DataDir 'setup.json'
$IsAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$Setup = $null
try { $Setup = Get-Content $SetupFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
$MakeShortcut = Join-Path $PSScriptRoot 'make-shortcut.ps1'
$PsExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"

# A function because it stops the halves with Stop-PortHolder, defined further down; it is called
# just before the backend is looked at.
function Invoke-Setup {
if (-not $Setup) {
    $yes = Ask ("How should Garden run on this PC?`n`n" +
        "Yes (recommended): with administrator rights, and the agents on your cards never stop to ask " +
        "for approval. Windows asks you once, now, and never again when Garden starts.`n`n" +
        "No: as a normal program, and cards ask before some actions.`n`n" +
        "With Yes, every card can change anything on this PC without asking. " +
        "You can change this later with scripts\make-shortcut.ps1 -Normal or -Elevated.") 'Set up Garden'
    $flag = if ($yes) { '-Elevated' } else { '-Normal' }
    $p = Start-Process $PsExe -Wait -PassThru -WindowStyle Hidden -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$MakeShortcut`" $flag"
    Write-Log "SETUP  $flag  exit $($p.ExitCode)"
    $chosen = $null
    try { $chosen = Get-Content $SetupFile -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
    if ($yes -and -not ($chosen -and $chosen.elevated)) {
        # The Windows prompt was declined, so nothing changed. Carry on as a normal program and ask
        # again next launch rather than record a choice that did not happen.
        Say 'Garden will run as a normal program this time. It will ask again next time it starts.'
    } elseif ($yes -and -not $IsAdmin) {
        foreach ($port in 5177, 5178) { if (Test-Port $port) { Stop-PortHolder $port | Out-Null } }
        Start-ScheduledTask -TaskName 'Garden'
        Write-Log 'EXIT 0  handed to the elevated task'
        exit 0
    }
} elseif ($Setup.elevated -and -not $IsAdmin -and (Get-ScheduledTask -TaskName 'Garden' -ErrorAction SilentlyContinue)) {
    Start-ScheduledTask -TaskName 'Garden'
    Write-Log 'EXIT 0  handed to the elevated task'
    exit 0
}
}

function Test-Port([int]$Port) {
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect('127.0.0.1', $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne(250)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Wait-Port([int]$Port, [int]$TimeoutSeconds) {
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (Test-Port $Port) { return $true }
        Start-Sleep -Milliseconds 400
    }
    return $false
}

<#
    Start one half of the pair.

    Each half is started on its own rather than through `npm run dev`, which starts both at once
    under `concurrently`. That is what made a half-running board a dead end: the only start command
    available would have collided with whichever half was already holding its port, so the script
    had nothing to offer except telling the owner to go and close a window by hand. The two npm
    scripts already exist separately, so half a Garden can now be completed rather than restarted.
#>
function Start-Half([string]$Script) {
    <#
        Output goes to a file, and the window is hidden rather than minimized.

        Both halves used to run in a visible console, and that is a way to freeze the whole board
        without touching it. A single click or drag inside a Windows console puts it into QuickEdit
        mark mode, which blocks every write to stdout until someone presses Escape. The server logs
        to stdout, so the blocked write parks its main thread and the Node event loop stops dead.
        The port stays open because the OS keeps accepting into the listen backlog, so nothing looks
        down: the board loads from Vite, draws the cards it last knew about, and then every request
        hangs forever with no error anywhere. This happened twice, hours apart, and cost a session of
        in-flight work each time. Writing to a file instead of a console makes it impossible, since a
        file handle has no mark mode to enter.

        Hiding the window is the other half of that. A console with nothing in it is only something
        to click in by accident, and the log below is the better place to look anyway. The board's
        own "Restart server" button is how a half gets stopped now.
    #>
    New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
    # 'dev:server' cannot be a filename on Windows, and a colon there would silently create an NTFS
    # alternate data stream rather than failing loudly.
    $name = $Script -replace '[^a-zA-Z0-9]+', '-'
    $out = Join-Path $LogDir "$name.log"
    $err = Join-Path $LogDir "$name.err.log"
    # Keep the previous run's output rather than truncating it. The launch that would overwrite it is
    # usually the launch being made to find out why the last one died.
    <#
        Rotation, and what to do when it cannot happen.

        A cmd.exe sitting at "Terminate batch job (Y/N)?" keeps the file it was redirected to open
        for as long as nobody answers, and that prompt is what a half gets when its console tree is
        killed rather than stopped. The handle outlives the half it belonged to: the port is free,
        nothing is serving, and the log can be neither renamed nor written. With
        $ErrorActionPreference = 'Stop' that turned every later launch into a script that died on
        this line, and under -WindowStyle Hidden there is no console for the error to appear in and
        no dialog, so from the desktop it is a shortcut that does nothing whatsoever. It stayed that
        way across repeated clicks, and only a run from a real console showed the reason.

        So a locked log is no longer allowed to stop a launch. This run writes to a stamped pair
        beside it instead, which is always a path nothing can be holding, and carries on. Nothing is
        lost: the stuck process keeps the old file, and the new one is named for when it was made.
    #>
    $rotated = $true
    foreach ($f in @($out, $err)) {
        if (-not (Test-Path $f)) { continue }
        try { Move-Item -Force -Path $f -Destination "$f.prev" -ErrorAction Stop }
        catch { $rotated = $false }
    }
    if (-not $rotated) {
        $stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
        $out = Join-Path $LogDir "$name-$stamp.log"
        $err = Join-Path $LogDir "$name-$stamp.err.log"
    }
    # Remember where this half's output actually went, because the stamped fallback above means the
    # failure messages below can no longer assume the name. Naming a log that does not exist is a
    # worse answer than naming none.
    $script:ErrLogs[$Script] = $err
    Start-Process -FilePath 'cmd.exe' `
        -ArgumentList '/c', "npm run $Script" `
        -WorkingDirectory $Root `
        -WindowStyle Hidden `
        -RedirectStandardOutput $out `
        -RedirectStandardError $err | Out-Null
}

<#
    Launcher processes from earlier double-clicks that are stuck and invisible.

    Only this script's own, identified by the -File argument naming launch.ps1, and never the current
    process. A hidden window blocked on a dialog nobody can see is indistinguishable from one that is
    working, so these accumulate silently: each failed double-click leaves one behind forever.
#>
function Get-StuckLaunchers() {
    $me = $PID
    <#
        Older than any legitimate run could still be waiting.

        The two waits below are ninety seconds each, so a launcher started three minutes ago has
        either finished or is never going to. Without this, double-clicking twice in quick
        succession would have the second run offer to kill the first while it was correctly waiting
        for a port, which turns a harmless impatient click into a broken start.
    #>
    $cutoff = (Get-Date).AddMinutes(-3)
    return @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" |
        Where-Object {
            $_.ProcessId -ne $me -and
            $_.CommandLine -and
            $_.CommandLine -match 'launch\.ps1' -and
            $_.CreationDate -lt $cutoff
        })
}

$stuck = Get-StuckLaunchers
if ($stuck.Count -gt 0) {
    $clear = Ask ("$($stuck.Count) earlier attempt(s) to open Garden are still stuck in the background.`n`n" +
        "They are waiting on a prompt in a hidden window, so they will never finish on their own. " +
        "This happened because an older version of this launcher reported failures to a console " +
        "that is not there when it runs from the shortcut.`n`nClose them?")
    if ($clear) {
        foreach ($p in $stuck) {
            try { Stop-Process -Id $p.ProcessId -Force -ErrorAction Stop } catch { }
        }
    }
}

$serverUp = Test-Port $ServerPort

<#
    Stop whatever is listening on a port, and wait until it really lets go.

    Waiting on the port rather than on the process exiting, because a listening socket outlives the
    process that owned it by a moment, and handing a replacement an address still in use is the
    failure this whole function exists to prevent.

    Three answers rather than true and false, because "nothing was there" and "it would not die" are
    both not-replaced and only one of them is a problem. The caller uses 'stuck' to explain a failure
    that would otherwise be reported as the UI simply not starting, which sends the owner to a log
    about a port the new process never reached.

    Every failure is answered rather than thrown. This runs from a double-clicked shortcut with no
    console, so an unhandled error here is a Garden that silently does not open.
#>
function Stop-PortHolder([int]$Port, [int]$TimeoutSeconds = 15) {
    <#
        Whether the cmdlet exists is asked separately from whether it found anything, because
        `Get-NetTCPConnection` THROWS when nothing matches rather than returning an empty set. Catching
        that and calling it 'unknown' made 'free' unreachable: a perfectly ordinary cold start reported
        that the port could not be examined. Tested, and that is exactly what it did.
    #>
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return 'unknown' }
    $held = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($held.Count -eq 0) { return 'free' }
    foreach ($h in $held) {
        try { Stop-Process -Id $h.OwningProcess -Force -ErrorAction Stop } catch { }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Port $Port)) { return 'replaced' }
        Start-Sleep -Milliseconds 300
    }
    return 'stuck'
}

<#
    The backend is reused when it is already up. The page half never is.

    These two halves look symmetrical and are not. The backend holds every PTY on the board, so
    reusing a running one is the whole reason a half-started Garden can be completed instead of
    restarted, and replacing it would end every card's process.

    The page half holds nothing. Reusing it was decided by asking whether 5177 answered, which says
    only that some Vite is there, never how old the code behind it is. Vite runs `strictPort: true`,
    so a surviving process keeps the port and any replacement exits rather than moving aside. The
    owner therefore closed Garden, reopened it from this shortcut, and was served by a Vite started
    six hours earlier, twice on separate days, with nothing on screen to say so until the version
    header started reporting it as "builds differ".

    So the page half is replaced on every launch. It costs a few seconds and no state, which is a
    trade worth making for a guarantee that the shortcut opens the code on disk. See
    docs/canonical/22-which-build-is-running.md.
#>
<#
    Reuse the running backend only if it is running the code on disk.

    The owner's words: "that should be a one shot button, it hsould just open a fresh build on
    current server with garden shortcut". He is right, and the two-icon arrangement this replaces was
    me making my problem his. Reuse is worth having, because the backend holds every PTY on the
    board, but it was unconditional, so a backend from before the last change was kept forever and
    the shortcut could not put him on a new build no matter how many times he pressed it. He pressed
    it three times.

    So the question is no longer "is a backend running" but "is the running backend the one this
    checkout would start". Compared on the version, which is the number canon 22 moves for anything
    he can see or feel, and therefore exactly the set of changes worth ending sessions for.

    When it matches, nothing happens and his sessions live. When it does not, the backend is replaced
    and its cards come back through the usual revival path: working, starting and needs-input cards
    are restarted, idle ones stay down, which is the same thing that happens after any restart.

    Every failure here answers "reuse it". A version that cannot be read is not evidence of a stale
    backend, and ending every session on the board over a failed HTTP request would be the worst
    possible reading of an unknown.
#>
function Get-RunningServerVersion([int]$Port) {
    try {
        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 4
        if ($health.build.version) { return [string]$health.build.version }
        return $null
    } catch {
        return $null
    }
}

function Get-CheckoutServerVersion([string]$RootPath) {
    try {
        return [string]((Get-Content (Join-Path $RootPath 'server\package.json') -Raw | ConvertFrom-Json).version)
    } catch {
        return $null
    }
}

Invoke-Setup
Write-Log ("BACKEND  already up: $serverUp")
$serverPortWas = 'kept'
if ($serverUp) {
    $running = Get-RunningServerVersion $ServerPort
    $onDisk = Get-CheckoutServerVersion $Root
    Write-Log ("VERSION  running '" + $running + "'  on disk '" + $onDisk + "'")
    if ($running -and $onDisk -and $running -ne $onDisk) {
        $serverPortWas = Stop-PortHolder $ServerPort
        Write-Log ("BACKEND  version differs, stopping $ServerPort -> $serverPortWas")
        if ($serverPortWas -ne 'stuck') { $serverUp = $false }
    } else {
        Write-Log 'BACKEND  reused, its sessions are kept'
    }
}

<#
    Tell the backend which page half is its own.

    Inherited by everything Start-Half launches from here. The server uses it for two things: the URL
    it prints at startup, which it already did, and the page half its Restart server button replaces,
    which is new. That button used to restart the backend alone and leave the owner reading the old
    version with "builds differ" beside it.

    Set here rather than defaulted in the server, because the default would apply to every instance a
    test starts, and a test restarting itself would then stop the owner's real Vite. Nothing but this
    launcher sets it. See docs/canonical/22-which-build-is-running.md.
#>
$env:GARDEN_WEB_PORT = "$WebPort"

if (-not $serverUp) {
    Write-Log 'START  dev:server'
    Start-Half 'dev:server'
    Write-Log ("START  dev:server launched, errors to " + $ErrLogs['dev:server'])
}
$webPortWas = Stop-PortHolder $WebPort
Write-Log ("PAGE  stopping $WebPort -> $webPortWas")
# Two npm installs racing on the same lockfile is worth avoiding, and starting the second a moment
# later costs nothing when the wait below is ninety seconds.
if (-not $serverUp) { Start-Sleep -Milliseconds 800 }
Write-Log 'START  dev:web'
Start-Half 'dev:web'
Write-Log ("START  dev:web launched, errors to " + $ErrLogs['dev:web'])

if (-not (Wait-Port $ServerPort 90)) {
    Write-Log "WAIT  backend did not answer on $ServerPort within 90s"
    $serverErrLog = if ($ErrLogs['dev:server']) { $ErrLogs['dev:server'] } else { "$LogDir\dev-server.err.log" }
    Say ("The Garden backend did not start within 90 seconds.`n`n" +
        "What it printed is in:`n`n    $serverErrLog`n`n" +
        "To watch it live instead, open a terminal in $Root and run:`n`n    npm run dev:server") 'Garden did not start' 'Error'
    Write-Log 'EXIT 1  backend never answered'
    exit 1
}
Write-Log "WAIT  backend answering on $ServerPort"

if (-not (Wait-Port $WebPort 90)) {
    Write-Log "WAIT  page half did not answer on $WebPort within 90s (port was '$webPortWas')"
    # Naming the likely cause rather than only the symptom. Vite is strictPort, so the one way this
    # fails after a replacement is that the old process never let go of 5177, and "did not start"
    # sends the owner to a log that will say nothing about a port it never reached.
    $why = if ($webPortWas -eq 'stuck') {
        "`n`nSomething was holding port $WebPort and would not let go, which is almost certainly why: " +
        "Vite is configured strictPort, so a replacement exits rather than choosing another port."
    } else { '' }
    $webErrLog = if ($ErrLogs['dev:web']) { $ErrLogs['dev:web'] } else { "$LogDir\dev-web.err.log" }
    Say ("The Garden backend is running, but the UI did not start within 90 seconds.$why`n`n" +
        "What it printed is in:`n`n    $webErrLog`n`n" +
        "To watch it live instead, open a terminal in $Root and run:`n`n    npm run dev:web") 'Garden did not start' 'Error'
    Write-Log 'EXIT 1  page half never answered'
    exit 1
}
Write-Log "WAIT  page half answering on $WebPort"

<#
    The owner key, handed to the window in the URL fragment.

    Canon has said since the ownership plane was designed that the key reaches the browser through
    the URL the server prints, and until now nothing built it: this script opened the board bare and
    a paste field in the sidebar stood in for the flow. Without the key a window is a guest as soon
    as the board enforces, which reads as the app having gone read-only for no visible reason.

    A fragment rather than a query string, because a fragment is never sent with the request: it
    reaches no server, no access log and no proxy. The page reads it once and strips it.

    The file is written by the server as it starts, so it exists by the time the port answers, but
    not necessarily at the same instant: the same short wait the ports get, and if it never appears
    the board still opens. A window with no key is a guest rather than a failure, and the owner would
    rather have the board with a limitation he can see than a dialog instead of it.
#>
$KeyFile = Join-Path $env:USERPROFILE '.garden\owner.key'
$key = $null
$keyDeadline = (Get-Date).AddSeconds(10)
while ((Get-Date) -lt $keyDeadline) {
    if (Test-Path $KeyFile) {
        $key = (Get-Content $KeyFile -Raw -ErrorAction SilentlyContinue)
        if ($key) { $key = $key.Trim() }
        if ($key) { break }
    }
    Start-Sleep -Milliseconds 300
}
# Never written to the console or a log. The only place this value goes is into the argument list of
# the browser being started, which is the one place it has to be.
$OpenUrl = if ($key) { "$Url#key=$key" } else { $Url }
# The bare URL and whether a key was found, never the key and never $OpenUrl. A launch trace is worth
# having and is not worth writing the owner key into a file to get: "guest" in this log is the
# symptom worth seeing, and the key itself adds nothing to the diagnosis.
Write-Log ("OPEN  $Url  key " + $(if ($key) { 'found' } else { 'MISSING, window opens as a guest' }))

# Chrome's app mode gives a real window with no tabs or address bar, which is as close to a
# desktop app as this gets before the Electron shell is built.
$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (Test-Path $chrome) {
    # A separate profile directory is what makes --app open its own window instead of being
    # absorbed as a tab by an already-running Chrome.
    $profileDir = Join-Path $env:LOCALAPPDATA 'Garden\chrome-profile'
    New-Item -ItemType Directory -Force -Path $profileDir | Out-Null
    # Start-Process, not the call operator: this script must hand off and exit rather than sit
    # attached to the browser for as long as the window is open.
    # A debugging port, so the window can be reloaded without the owner reaching for it.
    #
    # The interface is a build served by Vite, so a change under apps/web is not on screen until the
    # page reloads. Every card that ships one otherwise ends with "now press refresh", and a board
    # showing the previous build while everyone discusses the current one is exactly the kind of
    # quiet disagreement between what is true and what is drawn that this project exists to remove.
    #
    # Loopback only, and it is worth knowing what it costs: anything running as this user can drive
    # this browser profile while the window is open. That profile holds nothing but the board, which
    # is served from loopback, and the machine is single user. Remove the flag to close it.
    Start-Process -FilePath $chrome -ArgumentList @(
        "--app=$OpenUrl",
        "--user-data-dir=`"$profileDir`"",
        '--remote-debugging-port=9222',
        '--remote-allow-origins=http://127.0.0.1:9222',
        '--window-size=1920,1200',
        '--no-first-run',
        '--no-default-browser-check'
    ) | Out-Null
    Write-Log 'OPEN  chrome --app window started'
} else {
    Start-Process $OpenUrl
    Write-Log 'OPEN  no chrome at the expected path, handed the URL to the default browser'
}
Write-Log 'EXIT 0  launch complete'
