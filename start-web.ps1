$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$nodeCandidates = @(
  "C:\Users\Hong\AppData\Local\OpenAI\Codex\bin\node.exe",
  "C:\Users\Hong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $node) {
  try {
    $node = (Get-Command node -ErrorAction Stop).Source
  } catch {
    Write-Host "未找到 Node.js。请先安装 Node.js 18+，然后重新双击 start-web.bat。" -ForegroundColor Red
    Write-Host "下载地址：https://nodejs.org/" -ForegroundColor Yellow
    Read-Host "按 Enter 退出"
    exit 1
  }
}
Write-Host ""
Write-Host "Lyrics Map Web 原型即将启动..." -ForegroundColor Cyan
Write-Host "本机访问：http://localhost:4174" -ForegroundColor Green
$addresses = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue |
  Where-Object { $_.IPAddress -notlike "127.*" -and $_.PrefixOrigin -ne "WellKnown" } |
  Select-Object -ExpandProperty IPAddress -Unique
foreach ($address in $addresses) {
  Write-Host "同一 Wi-Fi / 热点访问：http://$address`:4174" -ForegroundColor Green
}
Write-Host ""
Write-Host "答辩时请保持这个窗口不要关闭。若其他设备打不开，请允许 Windows 防火墙访问 Node.js。" -ForegroundColor Yellow
Write-Host ""
& $node server.mjs
