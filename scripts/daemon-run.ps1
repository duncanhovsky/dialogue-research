$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$token = [Environment]::GetEnvironmentVariable('TELEGRAM_BOT_TOKEN', 'User')
if (-not $token) {
  throw 'TELEGRAM_BOT_TOKEN is not set in user environment.'
}

$env:TELEGRAM_BOT_TOKEN = $token
$env:NODE_ENV = 'production'

$dist = Join-Path $projectRoot 'dist\daemon.js'
if (-not (Test-Path $dist)) {
  throw 'dist/daemon.js not found. Please run npm run build first.'
}

node $dist
