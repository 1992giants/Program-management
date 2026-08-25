param(
  [string]$DatabasePath = "",
  [string]$BackupDirectory = "",
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$CenterAppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $CenterAppRoot

$env:NODE_ENV = "production"

if (-not $DatabasePath -and -not $env:ONMAEUM_DB_PATH) {
  $LocalEnvPath = Join-Path $CenterAppRoot ".env.local"
  if (Test-Path -LiteralPath $LocalEnvPath) {
    $DatabaseEntry = Get-Content -LiteralPath $LocalEnvPath | Where-Object { $_ -match '^\s*ONMAEUM_DB_PATH\s*=' } | Select-Object -Last 1
    if ($DatabaseEntry) {
      $env:ONMAEUM_DB_PATH = (($DatabaseEntry -split '=', 2)[1]).Trim().Trim('"').Trim("'")
    }
  }
}

if (-not $DatabasePath -and -not $env:ONMAEUM_DB_PATH) {
  throw "운영 DB 경로가 없습니다. -DatabasePath 또는 ONMAEUM_DB_PATH에 서버 PC의 로컬 절대경로를 지정하세요."
}

if ($DatabasePath) {
  $env:ONMAEUM_DB_PATH = $DatabasePath
}

if ($BackupDirectory) {
  $env:ONMAEUM_BACKUP_DIR = $BackupDirectory
}

if (-not (Test-Path -LiteralPath ".next")) {
  Write-Host "처음 실행을 준비합니다..."
  npm run build
}

$DatabaseLabel = $env:ONMAEUM_DB_PATH
$BackupLabel = if ($env:ONMAEUM_BACKUP_DIR) { $env:ONMAEUM_BACKUP_DIR } else { Join-Path (Split-Path -Parent $DatabaseLabel) "backups" }
Write-Host ""
Write-Host "센터 프로그램 참여관리 서버가 시작됩니다."
Write-Host "데이터 파일: $DatabaseLabel"
Write-Host "백업 폴더: $BackupLabel"
Write-Host "이 PC: http://localhost:$Port"
Write-Host "다른 내부 PC: http://[이 PC의 내부 IP]:$Port"
Write-Host "종료하려면 이 창에서 Ctrl+C를 누르세요."
Write-Host ""

npx next start -H 0.0.0.0 -p $Port
