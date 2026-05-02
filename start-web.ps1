$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot
$nodeCandidates = @(
  "C:\Users\Hong\AppData\Local\OpenAI\Codex\bin\node.exe",
  "C:\Users\Hong\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
)
$node = $nodeCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if (-not $node) {
  $node = (Get-Command node -ErrorAction Stop).Source
}
& $node server.mjs
