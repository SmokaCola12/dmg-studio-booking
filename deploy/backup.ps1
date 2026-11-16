# Runs one backup (the same as "npm run backup"). This is what the scheduled task starts.
# Settings come from .env in the project folder (BACKUP_DIR, BACKUP_PASSPHRASE ...). Exit code 0 means the backup was
# written and verified; anything else means it failed. Each run adds one line to backup.log in the backup folder.
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) {
  Write-Host '[backup] FAILED: Node.js was not found on PATH.'
  exit 1
}
Set-Location -LiteralPath $repo
# The backup writes warnings (for example "NOT ENCRYPTED") to stderr. Under 'Stop', Windows PowerShell 5.1 turns
# redirected stderr text into a terminating error, which would fail a good backup, so Node's exit code alone decides.
$ErrorActionPreference = 'Continue'
& $node (Join-Path $repo 'deploy\backup.mjs') 2>&1 | ForEach-Object { "$_" }
exit $LASTEXITCODE
