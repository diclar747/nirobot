# Detiene el panel de Niro. Primero cierra el navegador de Facebook desde el
# propio panel: si se corta de golpe, el perfil (data\browser-profile) puede
# quedar bloqueado para el próximo arranque.
# Uso: npm run panel:detener
param([int]$Port = 8787)
$root = Split-Path -Parent $PSScriptRoot

try {
  Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:$Port/api/browser/close" -ContentType "application/json" -Body "{}" -TimeoutSec 60 | Out-Null
} catch {
  Write-Host "No se pudo cerrar Facebook desde el panel ($($_.Exception.Message)); se cierra igual."
}

$listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
if ($listener) {
  Stop-Process -Id $listener.OwningProcess -Confirm:$false
  Write-Host "Panel detenido."
} else {
  Write-Host "El panel no estaba corriendo."
}

# Si quedó un Chrome usando el perfil del panel (por ejemplo, con contraseña activa), se cierra.
$profilePath = Join-Path $root "data\browser-profile"
Get-CimInstance Win32_Process -Filter "Name = 'chrome.exe' OR Name = 'msedge.exe'" |
  Where-Object { $_.CommandLine -and $_.CommandLine.Contains($profilePath) } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Confirm:$false -ErrorAction SilentlyContinue }
