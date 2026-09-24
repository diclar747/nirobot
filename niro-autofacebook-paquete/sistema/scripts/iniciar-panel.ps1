# Inicia el panel de Niro en segundo plano (sin ventana), independiente de la
# terminal que lo lanzó. El registro queda en data\logs\panel.log.
# Uso: npm run panel:iniciar
param([int]$Port = 8787)
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot

if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
  Write-Host "El panel ya está corriendo en http://127.0.0.1:$Port"
  exit 0
}

$logs = Join-Path $root "data\logs"
New-Item -ItemType Directory -Force $logs | Out-Null
$node = (Get-Command node -ErrorAction Stop).Source
Start-Process -FilePath $node -ArgumentList "server.mjs" -WorkingDirectory $root -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $logs "panel.log") -RedirectStandardError (Join-Path $logs "panel-errores.log")

for ($attempt = 0; $attempt -lt 60; $attempt++) {
  Start-Sleep -Milliseconds 500
  if (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue) {
    Write-Host "Panel listo: http://127.0.0.1:$Port"
    exit 0
  }
}
Write-Host "El panel no respondió. Revisá data\logs\panel-errores.log"
exit 1
