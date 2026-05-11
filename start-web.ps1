$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

$nodeCandidates = @()
try {
  $nodeCandidates += (Get-Command node -ErrorAction Stop).Source
} catch {
}
$nodeCandidates += @(
  "C:\Users\Hong\AppData\Local\OpenAI\Codex\bin\node.exe",
  "C:\Users\Hong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)

$node = $nodeCandidates |
  Where-Object { $_ -and (Test-Path -LiteralPath $_) } |
  Select-Object -Unique |
  Select-Object -First 1

if (-not $node) {
  Write-Host "Node.js was not found. Install Node.js 24 or newer, then run start-web.bat again." -ForegroundColor Red
  Write-Host "Download: https://nodejs.org/" -ForegroundColor Yellow
  Read-Host "Press Enter to exit"
  exit 1
}

Write-Host ""
Write-Host "Starting Lyrics Map Web..." -ForegroundColor Cyan
Write-Host "Local access: http://localhost:4174" -ForegroundColor Green

$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.AddressState -eq "Preferred" } |
  Select-Object -ExpandProperty IPAddress -Unique

foreach ($address in $addresses) {
  Write-Host "Same Wi-Fi / hotspot access: http://$address`:4174" -ForegroundColor Green
}

Write-Host ""
Write-Host "Keep this window open while presenting. If another device cannot open the site, allow Node.js through Windows Firewall for private networks." -ForegroundColor Yellow
Write-Host ""

& $node server.mjs
