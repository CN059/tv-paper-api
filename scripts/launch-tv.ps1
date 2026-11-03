# Launch TradingView Desktop with a CDP debug port bound to 127.0.0.1 only.
# Usage: powershell -ExecutionPolicy Bypass -File .\launch-tv.ps1 [-Port 9333] [-UserDataDir <path>]
param(
    [int]$Port = 9333,
    [string]$UserDataDir = ""
)

$exe = Get-ChildItem "C:\Program Files\WindowsApps" -Directory -Filter "TradingView.Desktop_*_x64__*" |
    Where-Object { Test-Path (Join-Path $_.FullName "TradingView.exe") } |
    Sort-Object Name -Descending |
    Select-Object -First 1

if (-not $exe) { Write-Error "TradingView is not installed"; exit 1 }
$exePath = Join-Path $exe.FullName "TradingView.exe"

$running = Get-Process TradingView -ErrorAction SilentlyContinue
if ($running) {
    Write-Host "TradingView is already running ($($running.Count) processes)." -ForegroundColor Yellow
    Write-Host "The debug port can only be set at launch: quit TradingView completely (tray icon too), then rerun this script." -ForegroundColor Yellow
    exit 2
}

$argList = @("--remote-debugging-port=$Port")
if ($UserDataDir) { $argList += "--user-data-dir=$UserDataDir" }

Start-Process -FilePath $exePath -ArgumentList $argList
Write-Host "Launched: $exePath  (CDP -> http://127.0.0.1:$Port)" -ForegroundColor Green

foreach ($i in 1..40) {
    Start-Sleep -Milliseconds 700
    try {
        $v = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/json/version" -TimeoutSec 1
        Write-Host "CDP ready: $($v.Browser)" -ForegroundColor Green
        exit 0
    } catch { }
}
Write-Host "CDP port not ready within 28s; check that TradingView started." -ForegroundColor Red
exit 3
