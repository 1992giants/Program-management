param(
  [string]$DatabasePath = "",
  [string]$BackupDirectory = "",
  [int]$Port = 3000,
  [switch]$InitializeProductionDatabase,
  [switch]$AdoptProductionDatabase,
  [switch]$MigrateUsrAdmin
)

$ErrorActionPreference = "Stop"
$CenterAppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
Set-Location -LiteralPath $CenterAppRoot

$TemporaryEnvironmentNames = @(
  "NODE_ENV",
  "ONMAEUM_INITIALIZE_PRODUCTION_DB",
  "ONMAEUM_ADOPT_PRODUCTION_DB",
  "ONMAEUM_MIGRATE_USR_ADMIN",
  "ONMAEUM_BOOTSTRAP_ADMIN_USERNAME",
  "ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME",
  "ONMAEUM_BOOTSTRAP_ADMIN_PIN"
)
$OriginalEnvironment = @{}
foreach ($Name in $TemporaryEnvironmentNames) {
  $Value = [Environment]::GetEnvironmentVariable($Name, "Process")
  $OriginalEnvironment[$Name] = @{ Exists = $null -ne $Value; Value = $Value }
}

try {
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

  if (-not [System.IO.Path]::IsPathRooted($env:ONMAEUM_DB_PATH)) {
    throw "운영 DB는 서버 PC의 로컬 절대경로여야 합니다."
  }

  if ($InitializeProductionDatabase -and ($AdoptProductionDatabase -or $MigrateUsrAdmin)) {
    throw "신규 DB 초기화 모드는 기존 DB adoption 또는 USR-ADMIN migration과 함께 사용할 수 없습니다."
  }

  if ($env:ONMAEUM_DB_PATH.StartsWith("\\")) {
    throw "운영 DB는 네트워크 공유경로에 둘 수 없습니다."
  }

  if ($BackupDirectory) {
    $env:ONMAEUM_BACKUP_DIR = $BackupDirectory
  }

  $BlockedRuntimeEnvironmentNames = @(
    "ONMAEUM_INITIALIZE_PRODUCTION_DB",
    "ONMAEUM_ADOPT_PRODUCTION_DB",
    "ONMAEUM_MIGRATE_USR_ADMIN",
    "ONMAEUM_BOOTSTRAP_ADMIN_USERNAME",
    "ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME",
    "ONMAEUM_BOOTSTRAP_ADMIN_PIN"
  )
  $IsOneShot = $InitializeProductionDatabase -or $AdoptProductionDatabase -or $MigrateUsrAdmin
  if ($IsOneShot) {
    if ($InitializeProductionDatabase) {
      if (Test-Path -LiteralPath $env:ONMAEUM_DB_PATH) {
        throw "초기화 모드는 새 DB 파일에만 사용할 수 있습니다. 기존 DB 경로를 확인하세요."
      }
    } elseif (-not (Test-Path -LiteralPath $env:ONMAEUM_DB_PATH)) {
      throw "일회성 작업 대상 운영 DB 파일이 존재하지 않습니다."
    }

    $CommandModes = @()
    if ($InitializeProductionDatabase) { $CommandModes += "initialize" }
    if ($AdoptProductionDatabase) { $CommandModes += "adopt" }
    if ($MigrateUsrAdmin) { $CommandModes += "migrate" }
    $LocalEnvPath = Join-Path $CenterAppRoot ".env.local"
    & node "--env-file-if-exists=$LocalEnvPath" --experimental-strip-types (Join-Path $CenterAppRoot "scripts\production-database.mjs") @CommandModes
    if ($LASTEXITCODE -ne 0) {
      throw "Production database one-shot 작업이 실패했습니다. 위 오류를 확인하세요."
    }

    Write-Host ""
    if ($InitializeProductionDatabase) {
      Write-Host "Production database initialization completed."
    } elseif ($AdoptProductionDatabase -and $MigrateUsrAdmin) {
      Write-Host "Production database adoption and USR-ADMIN migration completed."
    } elseif ($AdoptProductionDatabase) {
      Write-Host "Production database adoption completed."
    } else {
      Write-Host "USR-ADMIN migration completed."
    }
    Write-Host "The server has NOT been started."
    Write-Host "Remove any bootstrap credentials configured externally, then start the server normally:"
    Write-Host ".\start-center.ps1"
    return
  }

  $UnsafeRuntimeVariables = @()
  foreach ($Name in $BlockedRuntimeEnvironmentNames) {
    $Original = $OriginalEnvironment[$Name]
    if ($Original.Exists -and -not [string]::IsNullOrWhiteSpace([string]$Original.Value)) {
      $UnsafeRuntimeVariables += $Name
    }
  }
  $LocalEnvPath = Join-Path $CenterAppRoot ".env.local"
  if (Test-Path -LiteralPath $LocalEnvPath) {
    foreach ($Name in $BlockedRuntimeEnvironmentNames) {
      $Entry = Get-Content -LiteralPath $LocalEnvPath | Where-Object { $_ -match "^\s*$([regex]::Escape($Name))\s*=" } | Select-Object -Last 1
      if ($Entry) {
        $ConfiguredValue = (($Entry -split '=', 2)[1]).Trim().Trim('"').Trim("'")
        if (-not [string]::IsNullOrWhiteSpace($ConfiguredValue)) { $UnsafeRuntimeVariables += $Name }
      }
    }
  }
  $UnsafeRuntimeVariables = @($UnsafeRuntimeVariables | Sort-Object -Unique)
  if ($UnsafeRuntimeVariables.Count -gt 0) {
    throw "일반 production 실행 전에 maintenance/bootstrap 환경변수를 제거하세요: $($UnsafeRuntimeVariables -join ', ')"
  }

  foreach ($Name in $BlockedRuntimeEnvironmentNames) {
    Set-Item -LiteralPath "Env:$Name" -Value ""
  }

  if (-not (Test-Path -LiteralPath $env:ONMAEUM_DB_PATH)) {
    throw "운영 DB 파일이 존재하지 않습니다. 최초 초기화는 -InitializeProductionDatabase로 별도 실행하세요."
  }

  & node --experimental-strip-types (Join-Path $CenterAppRoot "scripts\production-database.mjs") validate
  if ($LASTEXITCODE -ne 0) {
    throw "운영 DB 사전 검증에 실패했습니다. 웹서버를 시작하지 않습니다."
  }

  if (-not (Test-Path -LiteralPath ".next")) {
    Write-Host "처음 실행을 준비합니다..."
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "프로덕션 빌드에 실패했습니다." }
  }

  $DatabaseLabel = $env:ONMAEUM_DB_PATH
  $BackupLabel = if ($env:ONMAEUM_BACKUP_DIR) { $env:ONMAEUM_BACKUP_DIR } else { Join-Path (Split-Path -Parent $DatabaseLabel) "backups" }
  Write-Host ""
  Write-Host "센터 프로그램 참여관리 서버가 시작됩니다."
  Write-Host "실행 모드: 일반 production 운영"
  Write-Host "데이터 파일: $DatabaseLabel"
  Write-Host "백업 폴더: $BackupLabel"
  Write-Host "이 PC: http://localhost:$Port"
  Write-Host "다른 내부 PC: http://[이 PC의 내부 IP]:$Port"
  Write-Host "종료하려면 이 창에서 Ctrl+C를 누르세요."
  Write-Host ""

  npx next start -H 0.0.0.0 -p $Port
} finally {
  foreach ($Name in $TemporaryEnvironmentNames) {
    $Original = $OriginalEnvironment[$Name]
    if ($Original.Exists) {
      [Environment]::SetEnvironmentVariable($Name, $Original.Value, "Process")
    } else {
      Remove-Item -LiteralPath "Env:$Name" -ErrorAction SilentlyContinue
    }
  }
}
