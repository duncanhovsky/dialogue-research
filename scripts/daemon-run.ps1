$ErrorActionPreference = 'Stop'

$projectRoot = Split-Path -Parent $PSScriptRoot
Set-Location $projectRoot

$requiredTelegramToken = [Environment]::GetEnvironmentVariable('TELEGRAM_BOT_TOKEN', 'User')
if (-not $requiredTelegramToken) {
  throw 'TELEGRAM_BOT_TOKEN is not set in user environment.'
}

$envNames = @(
  'TELEGRAM_BOT_TOKEN',
  'COPILOT_API_KEY',
  'GITHUB_TOKEN',
  'COPILOT_CHAT_COMPLETIONS_URL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'DEFAULT_MODEL',
  'DEV_WORKSPACE_ROOT',
  'COPILOT_MAX_RETRIES',
  'COPILOT_RETRY_BASE_MS',
  'COPILOT_TIMEOUT_MS',
  'COPILOT_MIN_INTERVAL_MS',
  'COPILOT_USAGE_LOG_PATH'
)

foreach ($name in $envNames) {
  $userValue = [Environment]::GetEnvironmentVariable($name, 'User')
  if ($userValue) {
    Set-Item -Path "Env:$name" -Value $userValue
  }
}

$env:NODE_ENV = 'production'

$dist = Join-Path $projectRoot 'dist\daemon.js'
if (-not (Test-Path $dist)) {
  throw 'dist/daemon.js not found. Please run npm run build first.'
}

node $dist
