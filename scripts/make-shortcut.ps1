<#
    Write the desktop shortcut that opens Garden.

    This existed only as a thing someone made by hand in Explorer once, which meant a shortcut that
    stopped working could be repaired but not reproduced, and nothing in the checkout recorded what
    it was supposed to point at. It points at launch.ps1, which is the only supported way in: it
    starts whichever halves are down, hands the browser the owner key, and opens the board in its own
    Chrome window. A shortcut to `npm run dev` would skip all three.

    Safe to run repeatedly. It overwrites the target path, so running it is the repair.
#>

param(
    [string]$Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Garden.lnk')
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Root 'scripts\launch.ps1'
$Icon = Join-Path $Root 'assets\garden.ico'

if (-not (Test-Path $Launcher)) { throw "No launcher at $Launcher" }

<#
    Windows PowerShell by name and full path, not `pwsh`.

    The launcher uses System.Windows.Forms for every message it shows, and the desktop is guaranteed
    to have Windows PowerShell while PowerShell 7 is an install that may not be there. The full path
    rather than the bare name because a shortcut resolves its target once, when it is written, and a
    PATH that changes later should not be able to point this somewhere else.

    -WindowStyle Hidden is the fact the launcher is written around: there is no console, so nothing
    it wants to say can be printed. -NoProfile keeps a slow or broken profile out of the start path.
#>
$shell = New-Object -ComObject WScript.Shell
$link = $shell.CreateShortcut($Path)
$link.TargetPath = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$link.Arguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""
$link.WorkingDirectory = $Root
$link.Description = 'Open Garden'
if (Test-Path $Icon) { $link.IconLocation = "$Icon,0" }
# 7 is minimized. The window it would be describing is the hidden PowerShell host, which no one
# should ever see; this only keeps a taskbar button from flashing up during the start.
$link.WindowStyle = 7
$link.Save()

Write-Output "Wrote $Path"
Write-Output "  -> $($link.TargetPath) $($link.Arguments)"
