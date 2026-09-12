# 센터 내부망 설치·운영 안내

이 프로그램은 인터넷 데이터베이스를 사용하지 않습니다. 한 대의 센터 PC가 서버 역할을 하고, 참가자·신청·출석 정보는 서버 PC의 로컬 `onmaeum.sqlite` 파일에 저장됩니다. 외장하드·NAS는 실시간 DB가 아니라 분리 백업 저장소로 사용하는 구조를 권장합니다.

## 권장 구성

1. 서버 PC의 로컬 디스크에 `C:\OnmaeumProgramCare\data` 폴더를 만듭니다.
2. 외장하드 또는 NAS에 백업용 `OnmaeumProgramCareBackups` 폴더를 만듭니다.
3. `.env.local.example`을 `.env.local`로 복사하고 production용 `ONMAEUM_DB_PATH`, development용 `ONMAEUM_DEV_DB_PATH`, `ONMAEUM_BACKUP_DIR`를 센터 환경에 맞게 수정합니다.
4. 새 production DB라면 최초 한 번 `start-center.ps1 -InitializeProductionDatabase`를 실행합니다. 이 명령은 DB 작업 후 종료하며 웹서버를 시작하지 않습니다.
5. bootstrap 값을 제거한 다음 `start-center.ps1`을 별도로 실행해야 평상시 운영 서버가 시작됩니다.
6. 서버 PC에서는 `http://localhost:3000`, 다른 내부 PC에서는 `http://서버PC의-내부-IP:3000`으로 접속합니다.

## 인증 Cookie와 내부망 HTTP

- `.env.local`의 `ONMAEUM_ALLOWED_ORIGINS`에는 직원이 실제로 접속하는 주소를 정확히 쉼표로 구분해 입력합니다. 예: `http://localhost:3000,http://192.168.0.10:3000`
- 현재 내부망 HTTP 운영에서는 `ONMAEUM_SECURE_COOKIES=0`을 사용합니다. 인증 Cookie는 HttpOnly·SameSite=Strict로 보호되지만 HTTP 네트워크 구간 자체는 암호화되지 않습니다.
- 같은 내부망의 감염 PC나 악성 장비가 통신을 가로채는 위험을 줄이려면 HTTPS reverse proxy와 센터 PC의 인증서 신뢰 구성을 별도 도입해야 합니다.
- HTTPS가 실제 적용된 뒤에만 `ONMAEUM_SECURE_COOKIES=1`로 변경합니다. forwarded header 값만 보고 Secure 설정을 자동 활성화하지 않습니다.

## 최초 관리자 만들기

고정된 기본 관리자 계정은 제공되지 않습니다. 새 DB를 처음 시작할 때 `.env.local`에 다음 세 값을 직접 정해 한 번만 설정하세요.

```dotenv
ONMAEUM_BOOTSTRAP_ADMIN_USERNAME=center-admin
ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME=센터 관리자
ONMAEUM_BOOTSTRAP_ADMIN_PIN=직접_정한_8자리_이상_PIN
```

PIN은 반복 숫자가 아닌 8자리 이상이어야 합니다. 신규 DB 파일이 아직 없는 상태에서 다음 명령으로 최초 초기화를 시작합니다.

```powershell
.\start-center.ps1 -InitializeProductionDatabase
```

명령이 성공하면 DB schema, production marker, 최초 관리자와 무결성 상태를 확인한 뒤 즉시 종료합니다. 웹서버는 시작되지 않습니다. 위 세 bootstrap 값을 `.env.local` 또는 외부 환경에서 제거하고 다음 명령으로 서버를 별도 실행하세요.

```powershell
.\start-center.ps1
```

일반 production 실행은 DB 파일과 올바른 production marker가 이미 존재해야 하며 초기화·adoption·관리자 migration 로직을 실행하지 않습니다. 최초 로그인 후에는 설정에서 PIN을 다시 변경해야 업무 기능을 사용할 수 있습니다.

이전 버전의 `USR-ADMIN`은 자동으로 삭제하거나 교체하지 않습니다. 발견되면 서버가 안전하게 중단됩니다. 이미 production marker가 있는 DB라면 DB 백업과 계정 정보를 확인한 뒤 위 bootstrap 세 값을 설정하고 다음 명령을 한 번만 실행하세요.

```powershell
.\start-center.ps1 -MigrateUsrAdmin
```

이 절차는 `USR-ADMIN` ID를 그대로 유지하면서 username·표시명·PIN을 변경하고 기존 로그인 세션을 모두 폐기한 뒤 종료합니다. 완료 후 bootstrap 값을 제거하고 옵션 없이 서버를 별도 실행하세요.

Sprint 1A 이전에 만들어진 marker 없는 기존 DB는 먼저 백업과 경로를 확인한 뒤 다음 명령을 한 번만 사용합니다.

```powershell
.\start-center.ps1 -AdoptProductionDatabase
```

핵심 Onmaeum 테이블과 SQLite 무결성이 확인된 경우에만 application·production marker가 기록되고 명령이 종료됩니다. development marker가 있는 DB는 production에서 열리지 않습니다. adoption 후에는 옵션 없이 서버를 별도 실행하세요.

marker 없는 기존 DB에 `USR-ADMIN`도 함께 남아 있다면 두 절차를 동시에 명시해야 합니다.

```powershell
.\start-center.ps1 -AdoptProductionDatabase -MigrateUsrAdmin
```

PowerShell에서 경로를 직접 지정해 실행할 수도 있습니다.

```powershell
.\start-center.ps1 -DatabasePath "C:\OnmaeumProgramCare\data\onmaeum.sqlite" -BackupDirectory "E:\OnmaeumProgramCareBackups"
```

## 운영 주의사항

### 기존 감사로그 민감정보 진단

기존 감사로그에서 민감 payload 가능성이 있는 행을 내용 노출 없이 작업·대상별 건수로 확인할 수 있습니다.

```powershell
npm run audit:scan -- --database "C:\OnmaeumProgramCare\data\onmaeum.sqlite"
```

이 명령은 DB를 읽기 전용으로 열고 의심 건수만 출력합니다. 기존 감사로그를 수정·삭제하거나 자동 정리하지 않습니다. 결과가 0건이어도 휴리스틱 진단상 후보가 없다는 의미이며 민감정보가 절대 없음을 보증하지 않습니다.

- 운영 DB를 UNC 공유경로에 두지 마세요. SQLite 파일은 서버 PC에서만 열고 직원 PC는 브라우저로 접속합니다.
- 운영 서버는 `ONMAEUM_DB_PATH`가 없으면 시작되지 않습니다. 개발 서버는 이 값을 사용하지 않고 `ONMAEUM_DEV_DB_PATH` 또는 별도의 기본 `data/development.sqlite`를 사용합니다.
- production 일반 실행은 기존 DB만 열며, 신규 DB 생성·기존 DB adoption·USR-ADMIN migration은 서로 다른 명시적 일회성 모드로 구분됩니다.
- 모든 일회성 모드는 작업과 무결성 확인 후 종료합니다. 일반 웹서버는 maintenance mode와 bootstrap credential을 전달하지 않은 별도 프로세스로만 시작합니다.
- 개발용 더미 데이터는 development에서 `ONMAEUM_ENABLE_DEMO_SEED=1`을 명시한 경우에만 생성되며 production에서는 항상 차단됩니다.
- 직원 계정은 공유하지 말고 관리자·일반 담당자·출석 입력 전용 권한을 업무에 맞게 부여하세요.
- 동시에 여러 프로그램이 SQLite 파일을 직접 열면 손상 위험이 있으므로 직원 PC는 반드시 브라우저로만 접속합니다.
- 업무 종료 전 설정 화면의 ‘백업 파일 만들기’를 사용한 뒤 서버를 종료하세요.
- 복원 전에는 반드시 ‘무결성 점검’을 실행하세요. 복원을 시작하면 현재 데이터는 자동으로 별도 안전 백업됩니다.
- 백업 복원 중에는 다른 직원이 참가자·출석 정보를 입력하지 않도록 안내하세요.
- 서버 종료 후 외장하드를 안전하게 분리하세요.
- Windows 방화벽에서 3000번 포트는 센터 내부 네트워크에만 허용하세요.
- 외장하드 암호화(BitLocker 등)와 별도 백업매체 보관을 권장합니다.

기존 인터넷 배포본은 샘플 확인용으로만 사용하고 실제 개인정보는 입력하지 마세요.
