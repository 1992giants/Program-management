param(
  [string]$DatabasePath = "",
  [int]$Port = 3000
)

$ErrorActionPreference = "Stop"
$CenterAppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $CenterAppRoot

if ($DatabasePath) {
  $env:ONMAEUM_DB_PATH = $DatabasePath
}

if (-not (Test-Path -LiteralPath ".next")) {
  Write-Host "처음 실행을 준비합니다..."
  npm run build
}

$DatabaseLabel = if ($env:ONMAEUM_DB_PATH) { $env:ONMAEUM_DB_PATH } else { Join-Path $CenterAppRoot "data\onmaeum.sqlite" }
Write-Host ""
Write-Host "센터 프로그램 참여관리 서버가 시작됩니다."
Write-Host "데이터 파일: $DatabaseLabel"
Write-Host "이 PC: http://localhost:$Port"
Write-Host "다른 내부 PC: http://[이 PC의 내부 IP]:$Port"
Write-Host "종료하려면 이 창에서 Ctrl+C를 누르세요."
Write-Host ""

npx next start -H 0.0.0.0 -p $Port
