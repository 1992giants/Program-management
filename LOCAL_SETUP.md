# 센터 내부망 설치·운영 안내

이 프로그램은 인터넷 데이터베이스를 사용하지 않습니다. 한 대의 센터 PC가 서버 역할을 하고, 참가자·신청·출석 정보는 서버 PC의 로컬 `onmaeum.sqlite` 파일에 저장됩니다. 외장하드·NAS는 실시간 DB가 아니라 분리 백업 저장소로 사용하는 구조를 권장합니다.

## 권장 구성

1. 서버 PC의 로컬 디스크에 `C:\OnmaeumProgramCare\data` 폴더를 만듭니다.
2. 외장하드 또는 NAS에 백업용 `OnmaeumProgramCareBackups` 폴더를 만듭니다.
3. `.env.local.example`을 `.env.local`로 복사하고 production용 `ONMAEUM_DB_PATH`, development용 `ONMAEUM_DEV_DB_PATH`, `ONMAEUM_BACKUP_DIR`를 센터 환경에 맞게 수정합니다.
4. `start-center.ps1`을 실행합니다.
5. 서버 PC에서는 `http://localhost:3000`, 다른 내부 PC에서는 `http://서버PC의-내부-IP:3000`으로 접속합니다.

## 최초 관리자 만들기

고정된 기본 관리자 계정은 제공되지 않습니다. 새 DB를 처음 시작할 때 `.env.local`에 다음 세 값을 직접 정해 한 번만 설정하세요.

```dotenv
ONMAEUM_BOOTSTRAP_ADMIN_USERNAME=center-admin
ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME=센터 관리자
ONMAEUM_BOOTSTRAP_ADMIN_PIN=직접_정한_8자리_이상_PIN
```

PIN은 반복 숫자가 아닌 8자리 이상이어야 합니다. 서버를 시작해 최초 관리자가 생성되면 위 세 줄을 `.env.local`에서 제거하고 서버를 다시 시작하세요. 동일한 설정이 남아 있어도 기존 직원 계정이 있으면 추가 관리자를 생성하지 않지만, 초기 자격증명을 파일에 계속 보관하지 않는 것이 안전합니다. 최초 로그인 후에는 설정에서 PIN을 다시 변경해야 업무 기능을 사용할 수 있습니다.

이전 버전에서 자동 생성된 관리자(`USR-ADMIN`)가 남아 있는 기존 DB도 위 세 값이 필요합니다. 시작 시 해당 자동 계정을 새 관리자 계정으로 한 번만 교체하며, 다른 직원 및 업무 기록은 유지합니다.

PowerShell에서 경로를 직접 지정해 실행할 수도 있습니다.

```powershell
.\start-center.ps1 -DatabasePath "C:\OnmaeumProgramCare\data\onmaeum.sqlite" -BackupDirectory "E:\OnmaeumProgramCareBackups"
```

## 운영 주의사항

- 운영 DB를 UNC 공유경로에 두지 마세요. SQLite 파일은 서버 PC에서만 열고 직원 PC는 브라우저로 접속합니다.
- 운영 서버는 `ONMAEUM_DB_PATH`가 없으면 시작되지 않습니다. 개발 서버는 이 값을 사용하지 않고 `ONMAEUM_DEV_DB_PATH` 또는 별도의 기본 `data/development.sqlite`를 사용합니다.
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
