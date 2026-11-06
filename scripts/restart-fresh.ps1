# Stop Garden completely, rewrite the database, and start it again on current code.
#
# This exists because there is no way to close Garden. Both halves are started with -WindowStyle
# Hidden by the launcher, so nothing appears on the taskbar and closing the browser tab closes
# nothing: the server and its Vite keep running, and the shortcut then reuses the server it finds,
# by design, because that server holds every PTY on the board.
#
# The owner hit that on 2026-09-08. He was told to close Garden and reopen it to move off v1.1.4,
# did what looked like closing it, and came back on v1.1.4 three times, because the thing he closed
# was the window and not the program. "im still on v 1.1.4" is what a missing stop looks like from
# his side.
#
# So this is the stop, and it does the other two things that can only happen while Garden is down:
# VACUUM, which needs exclusive access, and a launch that picks up new code in both halves at once.
#
# THIS ENDS EVERY SESSION ON THE BOARD. Cards are PTYs the server owns, so stopping the server stops
# all of them, including whichever card suggested running this. That is not a side effect to work
# around; it is what "close Garden" means, and it is why no card can run this on the owner's behalf.
#
#   powershell -ExecutionPolicy Bypass -File C:\Garden\scripts\restart-fresh.ps1
#
# Run it from an ordinary terminal, not from a card.

param(
    # Skip the database rewrite. The rewrite is the slow part and only earns its time when a lot has
    # been deleted, so a second run on the same day has no reason to pay for it again.
    [switch]$NoVacuum
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$WebPort = 5177
$ServerPort = 5178

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

<#
    Stop whatever is listening on a port, and say what was there.

    Get-NetTCPConnection THROWS when nothing matches rather than returning an empty set, which is
    why -ErrorAction SilentlyContinue and the array wrapper are both load-bearing: without them the
    "nothing was running" path is unreachable and this script fails on an already-stopped Garden.
#>
function Stop-PortHolder([int]$Port, [int]$TimeoutSeconds = 20) {
    if (-not (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue)) { return 'unknown' }
    $held = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue)
    if ($held.Count -eq 0) { return 'free' }
    foreach ($h in $held) {
        try { Stop-Process -Id $h.OwningProcess -Force -ErrorAction Stop } catch { }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    while ((Get-Date) -lt $deadline) {
        if (-not (Test-Port $Port)) { return 'stopped' }
        Start-Sleep -Milliseconds 300
    }
    return 'stuck'
}

Write-Output 'Stopping Garden.'
$serverWas = Stop-PortHolder $ServerPort
$webWas = Stop-PortHolder $WebPort
Write-Output "  server on $ServerPort : $serverWas"
Write-Output "  page   on $WebPort : $webWas"

if ($serverWas -eq 'stuck' -or $webWas -eq 'stuck') {
    Write-Output ''
    Write-Output 'A half would not stop. Nothing else has been done; the database was not touched.'
    exit 1
}

# A beat before touching the database. The server closes its SQLite handle as it dies and the
# rewrite below refuses to run against a handle that is still open, so this is the difference
# between a rewrite and an error message.
Start-Sleep -Milliseconds 1500

if (-not $NoVacuum) {
    Write-Output ''
    Write-Output 'Rewriting the database. Several minutes on a large file; it prints before and after.'
    & node (Join-Path $PSScriptRoot 'vacuum-db.mjs')
    if ($LASTEXITCODE -ne 0) {
        Write-Output ''
        Write-Output 'The rewrite did not finish. Garden is still stopped; open the shortcut to start it.'
        exit 1
    }
}

Write-Output ''
Write-Output 'Starting Garden on current code.'
& powershell -ExecutionPolicy Bypass -File (Join-Path $PSScriptRoot 'launch.ps1')
