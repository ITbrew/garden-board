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
    [string]$Path = (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Garden.lnk'),
    # Run Garden with administrator rights and no approval prompts, through a scheduled task so Windows
    # asks once, now, and never at launch. Canon 01 revision 3.
    [switch]$Elevated,
    # Back to an ordinary launch, auto mode on the cards, and no task.
    [switch]$Normal
)

$ErrorActionPreference = 'Stop'

$Root = Split-Path -Parent $PSScriptRoot
$Launcher = Join-Path $Root 'scripts\launch.ps1'
$Icon = Join-Path $Root 'assets\garden.ico'
$TaskName = 'Garden'
$DataDir = if ($env:GARDEN_HOME) { $env:GARDEN_HOME } else { Join-Path $HOME '.garden' }
$PsExe = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
$LaunchArgs = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$Launcher`""

if (-not (Test-Path $Launcher)) { throw "No launcher at $Launcher" }

function Save-Setup([bool]$IsElevated) {
    if (-not (Test-Path $DataDir)) { New-Item -ItemType Directory -Path $DataDir -Force | Out-Null }
    $setup = @{ elevated = $IsElevated; approvals = $(if ($IsElevated) { 'never-ask' } else { 'auto' }); chosenAt = (Get-Date).ToString('o') }
    [IO.File]::WriteAllText((Join-Path $DataDir 'setup.json'), ($setup | ConvertTo-Json -Compress))
}

$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
$hasTask = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)
if (($Elevated -or ($Normal -and $hasTask)) -and -not $admin) {
    # Registering or removing a task that runs with highest privileges needs them once. This is the
    # one prompt.
    $flag = if ($Elevated) { '-Elevated' } else { '-Normal' }
    $p = Start-Process $PsExe -Verb RunAs -Wait -PassThru -ArgumentList "-NoProfile -ExecutionPolicy Bypass -File `"$PSCommandPath`" $flag -Path `"$Path`""
    exit $p.ExitCode
}

if ($Elevated) {
    # Interactive, so the board's windows appear on this desktop; highest, so they run elevated.
    $action = New-ScheduledTaskAction -Execute $PsExe -Argument $LaunchArgs -WorkingDirectory $Root
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
    Register-ScheduledTask -TaskName $TaskName -Action $action -Principal $principal -Settings $settings -Force | Out-Null
    Save-Setup $true
} elseif ($Normal) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Save-Setup $false
}

$useTask = [bool](Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue)

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
$link.TargetPath = $PsExe
# With the task, the shortcut only starts it: the task is what carries the elevation, with no prompt.
$link.Arguments = if ($useTask) { "-NoProfile -WindowStyle Hidden -Command Start-ScheduledTask -TaskName $TaskName" } else { $LaunchArgs }
$link.WorkingDirectory = $Root
$link.Description = 'Open Garden'
if (Test-Path $Icon) { $link.IconLocation = "$Icon,0" }
# 7 is minimized. The window it would be describing is the hidden PowerShell host, which no one
# should ever see; this only keeps a taskbar button from flashing up during the start.
$link.WindowStyle = 7
$link.Save()

Write-Output "Wrote $Path"
Write-Output "  -> $($link.TargetPath) $($link.Arguments)"
