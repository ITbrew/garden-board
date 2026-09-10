# Starts a throwaway Garden server for tests and screenshots.
#
# It uses its own database and its own ports, so running the harness never touches the real
# workspace. Deleting the live database to get a clean board is what made the app appear to
# forget which account a tab was using.
param([switch]$Stop)

$ErrorActionPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$db = Join-Path $env:TEMP 'garden-harness.db'

Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
  Where-Object { $_.CommandLine -like '*GARDEN_HARNESS*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

if ($Stop) { Write-Output 'harness stopped'; exit 0 }

Remove-Item "$db*" -Force
$env:GARDEN_DB = $db
$env:GARDEN_HARNESS = '1'
Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', 'npm run dev:server' `
  -WorkingDirectory $root -WindowStyle Minimized
Write-Output "harness database: $db"
