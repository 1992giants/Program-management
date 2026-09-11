import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { hashPin, verifyPin } from '../db/index.ts';
import { SESSION_COOKIE_NAME, attendanceOnlySnapshot, canPerformAction, createAuthSession, getAuthenticatedUser, invalidateAuthSession, sessionCookie, sessionTokenDigest, validateMutationRequest } from '../lib/security.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');

function runNode(source,env={}) {
  return spawnSync(process.execPath,['--input-type=module','--eval',source],{
    cwd:projectRoot,
    env:{...process.env,...env},
    encoding:'utf8',
  });
}

function runProductionDatabase(modes,env={}) {
  return spawnSync(process.execPath,['--experimental-strip-types','scripts/production-database.mjs',...modes],{
    cwd:projectRoot,
    env:{...process.env,...env},
    encoding:'utf8',
  });
}

function runCenterScript(args,env={}) {
  return spawnSync('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(projectRoot,'start-center.ps1'),...args],{
    cwd:projectRoot,
    env:{...process.env,...env},
    encoding:'utf8',
    timeout:30000,
  });
}

test('production은 명시적인 DB 경로 없이 초기화되지 않는다',()=>{
  const result=runNode(`import { getDatabasePath } from './db/index.ts'; getDatabasePath();`,{
    NODE_ENV:'production',ONMAEUM_DB_PATH:'',ONMAEUM_DEV_DB_PATH:path.join(tmpdir(),'must-not-be-used.sqlite'),
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/ONMAEUM_DB_PATH/);
});

test('development와 production은 서로 다른 DB 경로 변수를 사용한다',()=>{
  const developmentPath=path.join(tmpdir(),'onmaeum-development.sqlite');
  const productionPath=path.join(tmpdir(),'onmaeum-production.sqlite');
  const development=runNode(`import { getDatabasePath } from './db/index.ts'; console.log(getDatabasePath());`,{NODE_ENV:'development',ONMAEUM_DEV_DB_PATH:developmentPath,ONMAEUM_DB_PATH:productionPath});
  const production=runNode(`import { getDatabasePath } from './db/index.ts'; console.log(getDatabasePath());`,{NODE_ENV:'production',ONMAEUM_DEV_DB_PATH:developmentPath,ONMAEUM_DB_PATH:productionPath});
  assert.equal(development.status,0,development.stderr);
  assert.equal(production.status,0,production.stderr);
  assert.equal(development.stdout.trim(),developmentPath);
  assert.equal(production.stdout.trim(),productionPath);
});

test('development marker가 있는 DB는 production 경로로 지정해도 열리지 않는다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-environment-marker-'));
  const databasePath=path.join(directory,'development.sqlite');
  try {
    const development=runNode(`import { getDatabase } from './db/index.ts'; const db=getDatabase(); console.log(db.prepare('SELECT value FROM settings WHERE key=?').get('database_environment').value);`,{
      NODE_ENV:'development',ONMAEUM_DEV_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'dev-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'개발 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975',
    });
    assert.equal(development.status,0,development.stderr);
    assert.equal(development.stdout.trim(),'development');
    const production=runNode(`import { getDatabase } from './db/index.ts'; getDatabase();`,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_ADOPT_PRODUCTION_DB:'1',
    });
    assert.notEqual(production.status,0);
    assert.match(production.stderr,/development DB를 production 환경에서 열 수 없습니다/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('production에서는 network DB 허용 변수를 설정해도 UNC 경로를 거부한다',()=>{
  const result=runNode(`import { getDatabase } from './db/index.ts'; getDatabase();`,{
    NODE_ENV:'production',ONMAEUM_DB_PATH:'\\\\CENTER-SERVER\\ProgramData\\onmaeum.sqlite',ONMAEUM_ALLOW_NETWORK_DB:'1',ONMAEUM_INITIALIZE_PRODUCTION_DB:'1',
  });
  assert.notEqual(result.status,0);
  assert.match(result.stderr,/production에서 적용되지 않습니다/);
});

test('production 일반 실행은 bootstrap 값이 있어도 없는 DB 파일을 생성하지 않는다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-no-bootstrap-'));
  const databasePath=path.join(directory,'production.sqlite');
  try {
    const result=runNode(`
      import { existsSync } from 'node:fs';
      import { getDatabase } from './db/index.ts';
      const errors=[];
      for(let attempt=0;attempt<2;attempt+=1){try{getDatabase()}catch(error){errors.push(error.message)}}
      console.log(JSON.stringify({errors,fileExists:existsSync(process.env.ONMAEUM_DB_PATH)}));
    `,{NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'configured-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'설정된 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975',ONMAEUM_INITIALIZE_PRODUCTION_DB:''});
    assert.equal(result.status,0,result.stderr);
    const checked=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(checked.errors.length,2);
    assert.equal(checked.fileExists,false);
    assert.equal(existsSync(databasePath),false);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('production 빈 DB는 명시적 관리자만 bootstrap하고 dummy 또는 admin\/1234를 만들지 않는다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-sprint1a-'));
  const databasePath=path.join(directory,'production.sqlite');
  const source=`
    import { getDatabase, verifyPin } from './db/index.ts';
    const db=getDatabase();
    const result={
      participants:db.prepare('SELECT COUNT(*) AS count FROM participants').get().count,
      programs:db.prepare('SELECT COUNT(*) AS count FROM programs').get().count,
      users:db.prepare('SELECT username,must_change_pin,pin_hash FROM staff_users').all().map(user=>({username:user.username,must_change_pin:user.must_change_pin,has_pin_hash:Boolean(user.pin_hash),scrypt_format:/^scrypt\\$/.test(user.pin_hash),accepts_default_pin:verifyPin(user.username,'1234',user.pin_hash)})),
      markers:Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN ('application_id','database_environment')").all().map(row=>[row.key,row.value])),
    };
    console.log(JSON.stringify(result));
  `;
  try {
    const first=runNode(source,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
      ONMAEUM_INITIALIZE_PRODUCTION_DB:'1',
      ONMAEUM_ENABLE_DEMO_SEED:'1',ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'center-owner',
      ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'센터 책임자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975',
    });
    assert.equal(first.status,0,first.stderr);
    const created=JSON.parse(first.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(created.participants,0);
    assert.equal(created.programs,0);
    assert.equal(created.users.length,1);
    assert.equal(created.users[0].username,'center-owner');
    assert.equal(created.users[0].must_change_pin,1);
    assert.equal(created.users[0].has_pin_hash,true);
    assert.equal(created.users[0].scrypt_format,true);
    assert.equal(created.users[0].accepts_default_pin,false);
    assert.deepEqual(created.markers,{application_id:'onmaeum-program-care',database_environment:'production'});

    const second=runNode(source,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
      ONMAEUM_INITIALIZE_PRODUCTION_DB:'',
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'second-admin',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'두 번째 관리자',
      ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',
    });
    assert.equal(second.status,0,second.stderr);
    const reopened=JSON.parse(second.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(reopened.users.map(user=>user.username),['center-owner']);
    assert.equal(reopened.users.some(user=>user.username==='admin'),false);
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});

test('PowerShell production 초기화는 one-shot으로 완료되고 재초기화는 기존 DB를 변경하지 않는다',{skip:process.platform!=='win32'},()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-one-shot-init-'));
  const databasePath=path.join(directory,'production.sqlite'),backupDirectory=path.join(directory,'backups');
  const credentials={
    ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'one-shot-owner',
    ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'일회성 관리자',
    ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975',
    ONMAEUM_INITIALIZE_PRODUCTION_DB:'1',
  };
  try {
    const initialized=runCenterScript(['-DatabasePath',databasePath,'-BackupDirectory',backupDirectory,'-InitializeProductionDatabase'],credentials);
    assert.equal(initialized.status,0,initialized.stderr||initialized.stdout);
    assert.equal(initialized.error,undefined);
    assert.match(initialized.stdout,/initialization completed/);
    assert.match(initialized.stdout,/server has NOT been started/);
    assert.doesNotMatch(initialized.stdout,/센터 프로그램 참여관리 서버가 시작됩니다/);

    const db=new DatabaseSync(databasePath,{readOnly:true});
    const before={
      users:db.prepare('SELECT id,username FROM staff_users ORDER BY id').all(),
      markers:db.prepare("SELECT key,value FROM settings WHERE key IN ('application_id','database_environment') ORDER BY key").all(),
    };
    db.close();
    assert.equal(before.users.length,1);
    assert.equal(before.users[0].username,'one-shot-owner');
    assert.deepEqual(before.markers.map(row=>[row.key,row.value]),[['application_id','onmaeum-program-care'],['database_environment','production']]);

    const reinitialized=runCenterScript(['-DatabasePath',databasePath,'-BackupDirectory',backupDirectory,'-InitializeProductionDatabase'],credentials);
    assert.notEqual(reinitialized.status,0);
    const reopened=new DatabaseSync(databasePath,{readOnly:true});
    assert.deepEqual(reopened.prepare('SELECT id,username FROM staff_users ORDER BY id').all(),before.users);
    assert.deepEqual(reopened.prepare("SELECT key,value FROM settings WHERE key IN ('application_id','database_environment') ORDER BY key").all(),before.markers);
    reopened.close();

    const unsafeNormalStart=runCenterScript(['-DatabasePath',databasePath,'-BackupDirectory',backupDirectory],credentials);
    assert.notEqual(unsafeNormalStart.status,0);
    assert.match(unsafeNormalStart.stderr,/maintenance\/bootstrap/);
    assert.match(unsafeNormalStart.stderr,/ONMAEUM_BOOTSTRAP_ADMIN_PIN/);
    assert.doesNotMatch(unsafeNormalStart.stdout,/센터 프로그램 참여관리 서버가 시작됩니다/);

    const normalValidation=runProductionDatabase(['validate'],{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory,
      ONMAEUM_INITIALIZE_PRODUCTION_DB:'1',ONMAEUM_ADOPT_PRODUCTION_DB:'1',ONMAEUM_MIGRATE_USR_ADMIN:'1',
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'must-not-reach-runtime',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'미전달',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',
    });
    assert.equal(normalValidation.status,0,normalValidation.stderr);
    assert.match(normalValidation.stdout,/"operation":"validate"/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('marker 없는 기존 DB는 normal 검증을 거부하고 명시적 adoption만 one-shot으로 허용한다',{skip:process.platform!=='win32'},()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-one-shot-adopt-'));
  const databasePath=path.join(directory,'legacy.sqlite'),backupDirectory=path.join(directory,'backups');
  const credentials={ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'legacy-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'기존 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975'};
  try {
    const initialized=runProductionDatabase(['initialize'],{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory,...credentials,
    });
    assert.equal(initialized.status,0,initialized.stderr);
    const legacy=new DatabaseSync(databasePath);
    legacy.prepare("DELETE FROM settings WHERE key IN ('application_id','database_environment','database_initialized_at')").run();
    legacy.close();

    const blocked=runProductionDatabase(['validate'],{NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory});
    assert.notEqual(blocked.status,0);
    assert.match(blocked.stderr,/marker 없는 DB/);

    const adopted=runCenterScript(['-DatabasePath',databasePath,'-BackupDirectory',backupDirectory,'-AdoptProductionDatabase'],credentials);
    assert.equal(adopted.status,0,adopted.stderr||adopted.stdout);
    assert.match(adopted.stdout,/adoption completed/);
    assert.match(adopted.stdout,/server has NOT been started/);
    assert.doesNotMatch(adopted.stdout,/센터 프로그램 참여관리 서버가 시작됩니다/);

    const accepted=runProductionDatabase(['validate'],{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory,
      ONMAEUM_ADOPT_PRODUCTION_DB:'1',...credentials,
    });
    assert.equal(accepted.status,0,accepted.stderr);
    assert.match(accepted.stdout,/"productionMarker":true/);
  } finally {rmSync(directory,{recursive:true,force:true});}
});

test('USR-ADMIN은 자동 교체하지 않고 명시적 migration에서 같은 ID로 전환한다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-legacy-admin-'));
  const databasePath=path.join(directory,'production.sqlite');
  try {
    const create=runNode(`import { getDatabase } from './db/index.ts'; const db=getDatabase(); const original=db.prepare('SELECT id FROM staff_users').get(); db.prepare('UPDATE staff_users SET id=? WHERE id=?').run('USR-ADMIN',original.id); db.prepare('INSERT INTO auth_sessions (token,user_id,expires_at,created_at,last_seen_at,ip_address) VALUES (?,?,?,?,?,?)').run('legacy-session','USR-ADMIN','2999-01-01T00:00:00.000Z',new Date().toISOString(),new Date().toISOString(),'local'); db.prepare('INSERT INTO audit_logs (created_at,actor,action,entity_type,entity_id,before_json,after_json,summary,reason,ip_address) VALUES (?,?,?,?,?,?,?,?,?,?)').run(new Date().toISOString(),'기존 관리자','계정 확인','사용자','USR-ADMIN','','','기존 감사 이력','','local');`,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
      ONMAEUM_INITIALIZE_PRODUCTION_DB:'1',
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'temporary-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'임시 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975',
    });
    assert.equal(create.status,0,create.stderr);
    const blocked=runNode(`import { DatabaseSync } from 'node:sqlite'; import { getDatabase } from './db/index.ts'; let error=''; try{getDatabase()}catch(caught){error=caught.message} const raw=new DatabaseSync(process.env.ONMAEUM_DB_PATH,{readOnly:true}); const state={error,user:raw.prepare('SELECT id,username FROM staff_users').get(),sessions:raw.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?').get('USR-ADMIN').count}; raw.close(); console.log(JSON.stringify(state));`,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_INITIALIZE_PRODUCTION_DB:'',ONMAEUM_MIGRATE_USR_ADMIN:'',
    });
    assert.equal(blocked.status,0,blocked.stderr);
    const preserved=JSON.parse(blocked.stdout.trim().split(/\r?\n/).at(-1));
    assert.match(preserved.error,/USR-ADMIN/);
    assert.equal(preserved.user.id,'USR-ADMIN');
    assert.equal(preserved.user.username,'temporary-owner');
    assert.equal(preserved.sessions,1);

    const replace=runNode(`import { getDatabase } from './db/index.ts'; const db=getDatabase(); console.log(JSON.stringify({users:db.prepare('SELECT id,username,must_change_pin FROM staff_users').all(),sessions:db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?').get('USR-ADMIN').count,audit:db.prepare('SELECT COUNT(*) AS count FROM audit_logs WHERE entity_id=?').get('USR-ADMIN').count,reviewed:db.prepare('SELECT value FROM settings WHERE key=?').get('usr_admin_migration_completed')?.value}));`,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
      ONMAEUM_INITIALIZE_PRODUCTION_DB:'',ONMAEUM_MIGRATE_USR_ADMIN:'1',
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'rotated-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'교체 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',
    });
    assert.equal(replace.status,0,replace.stderr);
    const migrated=JSON.parse(replace.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(migrated.users.length,1);
    assert.equal(migrated.users[0].username,'rotated-owner');
    assert.equal(migrated.users[0].id,'USR-ADMIN');
    assert.equal(migrated.users[0].must_change_pin,1);
    assert.equal(migrated.sessions,0);
    assert.equal(migrated.audit,1);
    assert.equal(migrated.reviewed,'1');
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('authorization은 역할별 explicit allow, default deny를 적용한다',()=>{
  const attendance={role:'출석 입력 전용'};
  for(const action of ['attendance','attendanceBulk','closeAttendanceSession'])assert.equal(canPerformAction(attendance,action),true);
  for(const action of ['createUser','updateUser','backup','checkBackup','restoreBackup','mergeParticipants','settings','unknownAction'])assert.equal(canPerformAction(attendance,action),false);
  assert.equal(canPerformAction({role:'관리자'},'restoreBackup'),true);
  assert.equal(canPerformAction({role:'알 수 없는 역할'},'attendance'),false);
});

test('출석 전용 snapshot은 출석 업무에 불필요한 민감정보를 조회하거나 반환하지 않는다',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL);
    CREATE TABLE participants(id TEXT PRIMARY KEY,name TEXT,gender TEXT,age INTEGER,phone TEXT,member_status TEXT,note TEXT);
    CREATE TABLE programs(id TEXT PRIMARY KEY,name TEXT,delivery_type TEXT,session_count INTEGER,capacity INTEGER,status TEXT);
    CREATE TABLE program_runs(id TEXT PRIMARY KEY,program_id TEXT,round_number INTEGER,label TEXT,start_date TEXT,status TEXT,closed_at TEXT,closed_by TEXT);
    CREATE TABLE sessions(id TEXT PRIMARY KEY,run_id TEXT,session_number INTEGER,session_date TEXT,session_time TEXT,location TEXT,attendance_status TEXT,attendance_closed_at TEXT,attendance_closed_by TEXT,reopen_reason TEXT);
    CREATE TABLE applications(id INTEGER PRIMARY KEY,participant_id TEXT,program_id TEXT,run_id TEXT,status TEXT,status_reason TEXT);
    CREATE TABLE attendance(id INTEGER PRIMARY KEY,application_id INTEGER,session_id TEXT,status TEXT,note TEXT,contacted_at TEXT,makeup_for_session_id TEXT);
    CREATE TABLE assessment_scores(id INTEGER PRIMARY KEY,note TEXT);
    CREATE TABLE satisfaction_surveys(id INTEGER PRIMARY KEY,comment TEXT);
    INSERT INTO settings VALUES ('center_name','테스트 센터'),('manager_name','담당자');
    INSERT INTO participants VALUES ('P-1','홍길동','남성',40,'010-9876-5432','회원','participant-secret-memo');
    INSERT INTO programs VALUES ('PRG-1','회복 프로그램','집단',1,10,'운영 중');
    INSERT INTO program_runs VALUES ('RUN-1','PRG-1',1,'1차','2026-08-25','진행 중',NULL,NULL);
    INSERT INTO sessions VALUES ('S-1','RUN-1',1,'2026-08-25','10:00','프로그램실','작성 중',NULL,NULL,'');
    INSERT INTO applications VALUES (1,'P-1','PRG-1','RUN-1','참가중','application-secret-reason');
    INSERT INTO attendance VALUES (1,1,'S-1','참석','출석 업무 메모',NULL,NULL);
    INSERT INTO assessment_scores VALUES (1,'PHQ-9 GAD-7 PSS-10 secret-score');
    INSERT INTO satisfaction_surveys VALUES (1,'satisfaction-secret-free-text');
  `);
  try {
    const result=attendanceOnlySnapshot(db,{id:'U-1',username:'attendance',display_name:'출석 담당',role:'출석 입력 전용',active:1});
    const serialized=JSON.stringify(result);
    assert.equal(result.participants.length,0);
    assert.equal(result.assessmentScores.length,0);
    assert.equal(result.satisfactionSurveys.length,0);
    assert.equal(Object.hasOwn(result.applications[0],'phone'),false);
    assert.equal(Object.hasOwn(result.applications[0],'status_reason'),false);
    for(const secret of ['010-9876-5432','participant-secret-memo','application-secret-reason','PHQ-9','GAD-7','PSS-10','satisfaction-secret-free-text'])assert.equal(serialized.includes(secret),false);
  } finally { db.close(); }
});

test('Cookie session은 digest로 저장되고 logout 즉시 재사용할 수 없다',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,pin_hash TEXT,role TEXT,active INTEGER,must_change_pin INTEGER,last_login_at TEXT);
    CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,created_at TEXT,last_seen_at TEXT,ip_address TEXT);
  `);
  const stored=hashPin('attendance','48261590');
  db.prepare('INSERT INTO staff_users VALUES (?,?,?,?,?,1,0,NULL)').run('U-1','attendance','출석 담당',stored,'출석 입력 전용');
  assert.equal(verifyPin('attendance','48261590',stored),true);
  const session=createAuthSession(db,'U-1','local');
  const request=new Request('http://localhost/api/data',{headers:{Cookie:`${SESSION_COOKIE_NAME}=${session.secret}`}});
  const storedToken=db.prepare('SELECT token FROM auth_sessions').get().token;
  assert.equal(storedToken,sessionTokenDigest(session.secret));
  assert.notEqual(storedToken,session.secret);
  assert.equal(getAuthenticatedUser(request,db)?.id,'U-1');
  assert.equal(invalidateAuthSession(request,db),true);
  assert.equal(getAuthenticatedUser(request,db),undefined);
  assert.equal(getAuthenticatedUser(new Request('http://localhost/api/data',{headers:{Authorization:`Bearer ${session.secret}`}}),db),undefined);
  db.prepare('INSERT INTO auth_sessions VALUES (?,?,?,?,?,?)').run('legacy-raw-token','U-1','2999-01-01T00:00:00.000Z',new Date().toISOString(),new Date().toISOString(),'local');
  assert.equal(getAuthenticatedUser(new Request('http://localhost/api/data',{headers:{Cookie:`${SESSION_COOKIE_NAME}=legacy-raw-token`}}),db),undefined);
  db.close();
});

test('session Cookie는 HTTP와 HTTPS 설정에 맞는 속성을 사용한다',()=>{
  const original=process.env.ONMAEUM_SECURE_COOKIES;
  try {
    process.env.ONMAEUM_SECURE_COOKIES='0';
    const httpCookie=sessionCookie('secret');
    assert.match(httpCookie,/HttpOnly/);
    assert.match(httpCookie,/SameSite=Strict/);
    assert.match(httpCookie,/Path=\//);
    assert.doesNotMatch(httpCookie,/; Secure/);
    assert.doesNotMatch(httpCookie,/Max-Age|Expires/);
    process.env.ONMAEUM_SECURE_COOKIES='1';
    assert.match(sessionCookie('secret'),/; Secure/);
  } finally {
    if(original===undefined)delete process.env.ONMAEUM_SECURE_COOKIES;else process.env.ONMAEUM_SECURE_COOKIES=original;
  }
});

test('production mutation은 명시적인 exact Origin과 JSON만 허용한다',()=>{
  const originalNodeEnv=process.env.NODE_ENV,originalOrigins=process.env.ONMAEUM_ALLOWED_ORIGINS;
  try {
    process.env.NODE_ENV='production';
    delete process.env.ONMAEUM_ALLOWED_ORIGINS;
    const jsonHeaders={'Content-Type':'application/json'};
    assert.equal(validateMutationRequest(new Request('http://localhost/api/data',{method:'POST',headers:{...jsonHeaders,Origin:'http://localhost:3000'}}))?.status,403);
    process.env.ONMAEUM_ALLOWED_ORIGINS='http://localhost:3000,http://127.0.0.1:3000';
    assert.equal(validateMutationRequest(new Request('http://localhost/api/data',{method:'POST',headers:{...jsonHeaders,Origin:'http://localhost:3000'}})),undefined);
    assert.equal(validateMutationRequest(new Request('http://localhost/api/data',{method:'POST',headers:{...jsonHeaders,Origin:'http://localhost:3000.attacker.invalid'}}))?.status,403);
    assert.equal(validateMutationRequest(new Request('http://localhost/api/data',{method:'POST',headers:{Origin:'http://localhost:3000','Content-Type':'text/plain'}}))?.status,415);
  } finally {
    if(originalNodeEnv===undefined)delete process.env.NODE_ENV;else process.env.NODE_ENV=originalNodeEnv;
    if(originalOrigins===undefined)delete process.env.ONMAEUM_ALLOWED_ORIGINS;else process.env.ONMAEUM_ALLOWED_ORIGINS=originalOrigins;
  }
});

test('client 인증 코드에는 legacy localStorage token이 남지 않는다',()=>{
  const clientSource=readFileSync(path.join(projectRoot,'app/page.tsx'),'utf8');
  for(const legacy of ['onmaeum_auth','localStorage','Authorization','Bearer ','authToken'])assert.equal(clientSource.includes(legacy),false,legacy);
});

test('실제 API는 attendance 최소 응답, 권한 거부, 일괄 출석 원자성, logout 폐기를 보장한다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-route-integration-'));
  const databasePath=path.join(directory,'api-test.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET, POST } from './app/api/data/route.ts';
    import { getDatabase, hashPin } from './db/index.ts';
    import { SESSION_COOKIE_NAME, sessionTokenDigest } from './lib/security.ts';

    const db=getDatabase(),today='2026-08-25';
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-ATTENDANCE','attendance','출석 담당',hashPin('attendance','48261590'),'출석 입력 전용',today);
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-ROUTE-ADMIN','route-admin','통합 관리자',hashPin('route-admin','86420975'),'관리자',today);
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,0,?,0)').run('USR-INACTIVE','inactive-user','중지 계정',hashPin('inactive-user','86420975'),'일반 담당자',today);
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin,locked_until) VALUES (?,?,?,?,?,1,?,0,?)').run('USR-LOCKED','locked-user','잠긴 계정',hashPin('locked-user','86420975'),'일반 담당자',today,'2999-01-01T00:00:00.000Z');
    db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-1','홍길동','남성',40,'010-9876-5432','회원','participant-secret-memo',today);
    db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-2','김다른','여성',35,'010-1111-2222','비회원','other-secret-memo',today);
    db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('PRG-1','회복 프로그램','회복','집단',1,'매주','프로그램실','담당자',10,'운영 중',today);
    db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('PRG-2','다른 프로그램','회복','집단',1,'매주','다른실','담당자',10,'운영 중',today);
    db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run('RUN-1','PRG-1',1,'1차',today,'진행 중');
    db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run('RUN-2','PRG-2',1,'1차',today,'진행 중');
    db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)').run('SESSION-1','RUN-1',1,today,'10:00','프로그램실');
    db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)').run('SESSION-2','RUN-2',1,today,'11:00','다른실');
    db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number,status_reason) VALUES (?,?,?,?,?,?,?,?)').run(1,'P-1','PRG-1','RUN-1',today,'참가중',1,'application-secret-reason');
    db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number,status_reason) VALUES (?,?,?,?,?,?,?,?)').run(2,'P-2','PRG-2','RUN-2',today,'참가중',1,'other-application-secret-reason');
    db.prepare('INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at) VALUES (?,?,?,?,?,?)').run(1,'ASM-PHQ9',20,10,'assessment-secret-note',new Date().toISOString());
    db.prepare('INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at) VALUES (?,?,?,?)').run(1,5,'satisfaction-secret-free-text',new Date().toISOString());
    db.prepare('INSERT INTO certificates (participant_id,issued_at,session_count) VALUES (?,?,?)').run('P-1',today,1);
    db.prepare('INSERT INTO schedule_events (id,event_type,color,participant_id,title,event_date,created_at) VALUES (?,?,?,?,?,?,?)').run('EVENT-1','상담','green','P-1','unrelated-secret-schedule',today,new Date().toISOString());
    db.prepare('INSERT INTO audit_logs (created_at,actor,action,entity_type,entity_id,summary) VALUES (?,?,?,?,?,?)').run(new Date().toISOString(),'관리자','민감 작업','참가자','P-1','audit-secret-summary');

    const origin='http://localhost:3000';
    const post=(body,cookie,headers={})=>POST(new Request(origin+'/api/data',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin,...(cookie?{Cookie:cookie}:{}),...headers},body:JSON.stringify(body)}));
    const get=(cookie,headers={})=>GET(new Request(origin+'/api/data',{headers:{...(cookie?{Cookie:cookie}:{}),...headers}}));
    const cookieFrom=response=>response.headers.get('set-cookie').split(';')[0];

    const badOrigin=await post({action:'login',username:'attendance',pin:'48261590'},'',{Origin:'http://attacker.invalid'});
    assert.equal(badOrigin.status,403);
    const missingOrigin=await POST(new Request(origin+'/api/data',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'login',username:'attendance',pin:'48261590'})}));
    assert.equal(missingOrigin.status,403);
    const badContentType=await POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain'},body:JSON.stringify({action:'login',username:'attendance',pin:'48261590'})}));
    assert.equal(badContentType.status,415);

    const loginFailures=[];
    for(const credentials of [{username:'missing-user',pin:'00000000'},{username:'attendance',pin:'00000000'},{username:'locked-user',pin:'86420975'},{username:'inactive-user',pin:'86420975'}]){
      const response=await post({action:'login',...credentials});
      loginFailures.push({status:response.status,body:await response.json()});
    }
    for(const failure of loginFailures)assert.deepEqual(failure,loginFailures[0]);

    const loginResponse=await post({action:'login',username:'attendance',pin:'48261590'});
    assert.equal(loginResponse.status,200);
    assert.equal(loginResponse.headers.get('cache-control'),'no-store');
    const setCookie=loginResponse.headers.get('set-cookie');
    assert.match(setCookie,/HttpOnly/);
    assert.match(setCookie,/SameSite=Strict/);
    assert.match(setCookie,/Path=\\//);
    assert.doesNotMatch(setCookie,/; Secure/);
    const loginBody=await loginResponse.json(),cookie=cookieFrom(loginResponse),rawSecret=cookie.slice(SESSION_COOKIE_NAME.length+1);
    assert.equal(Object.hasOwn(loginBody,'authToken'),false);
    assert.equal(JSON.stringify(loginBody).includes(rawSecret),false);
    const storedSession=db.prepare('SELECT token FROM auth_sessions WHERE user_id=?').get('USR-ATTENDANCE').token;
    assert.equal(storedSession,sessionTokenDigest(rawSecret));
    assert.notEqual(storedSession,rawSecret);

    const protectedResponse=await get(cookie);
    assert.equal(protectedResponse.status,200);
    assert.equal(protectedResponse.headers.get('cache-control'),'no-store');
    const attendanceBody=await protectedResponse.json(),serialized=JSON.stringify(attendanceBody);
    assert.equal(attendanceBody.currentUser.role,'출석 입력 전용');
    assert.deepEqual(attendanceBody.participants,[]);
    assert.deepEqual(attendanceBody.assessmentScores,[]);
    assert.deepEqual(attendanceBody.satisfactionSurveys,[]);
    assert.deepEqual(attendanceBody.auditLogs,[]);
    assert.deepEqual(attendanceBody.users,[]);
    assert.deepEqual(attendanceBody.backupFiles,[]);
    assert.deepEqual(attendanceBody.certificates,[]);
    assert.deepEqual(attendanceBody.scheduleEvents,[]);
    assert.equal(Object.hasOwn(attendanceBody.applications[0],'phone'),false);
    assert.equal(Object.hasOwn(attendanceBody.applications[0],'note'),false);
    assert.equal(Object.hasOwn(attendanceBody.applications[0],'status_reason'),false);
    assert.equal(Object.hasOwn(attendanceBody.applications[0],'gender'),false);
    assert.equal(Object.hasOwn(attendanceBody.applications[0],'age'),false);
    for(const secret of ['010-9876-5432','participant-secret-memo','application-secret-reason','assessment-secret-note','satisfaction-secret-free-text','audit-secret-summary','unrelated-secret-schedule'])assert.equal(serialized.includes(secret),false);

    const bearerOnly=await get('',{Authorization:'Bearer '+rawSecret});
    assert.equal(bearerOnly.status,401);

    const validBulk=await post({action:'attendanceBulk',sessionId:'SESSION-1',applicationIds:[1],status:'참석'},cookie);
    assert.equal(validBulk.status,200);
    assert.equal(db.prepare('SELECT status FROM attendance WHERE application_id=1 AND session_id=?').get('SESSION-1').status,'참석');

    const invalidBulk=await post({action:'attendanceBulk',sessionId:'SESSION-1',applicationIds:[1,2],status:'결석'},cookie);
    assert.notEqual(invalidBulk.status,200);
    assert.equal(db.prepare('SELECT status FROM attendance WHERE application_id=1 AND session_id=?').get('SESSION-1').status,'참석');
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance WHERE application_id=2 AND session_id=?').get('SESSION-1').count,0);

    for(const action of ['backup','restoreBackup','mergeParticipants']){
      const denied=await post({action,path:'not-used',keepId:'P-1',mergeId:'P-2'},cookie);
      assert.equal(denied.status,403);
    }

    const adminLogin=await post({action:'login',username:'route-admin',pin:'86420975'}),adminCookie=cookieFrom(adminLogin);
    assert.equal(adminLogin.status,200);
    const duplicateUser=await post({action:'createUser',username:'route-admin',displayName:'중복',pin:'97531086',role:'일반 담당자'},adminCookie);
    assert.equal(duplicateUser.status,500);
    assert.deepEqual(await duplicateUser.json(),{error:'internal_server_error'});

    const roleChanged=await post({action:'updateUser',id:'USR-ATTENDANCE',displayName:'출석 담당',role:'일반 담당자',active:true,pin:''},adminCookie);
    assert.equal(roleChanged.status,200);
    assert.equal((await get(cookie)).status,401);

    const reloginAfterRole=await post({action:'login',username:'attendance',pin:'48261590'}),roleCookie=cookieFrom(reloginAfterRole);
    const disabled=await post({action:'updateUser',id:'USR-ATTENDANCE',displayName:'출석 담당',role:'일반 담당자',active:false,pin:''},adminCookie);
    assert.equal(disabled.status,200);
    assert.equal((await get(roleCookie)).status,401);

    await post({action:'updateUser',id:'USR-ATTENDANCE',displayName:'출석 담당',role:'일반 담당자',active:true,pin:''},adminCookie);
    const beforeReset=await post({action:'login',username:'attendance',pin:'48261590'}),resetCookie=cookieFrom(beforeReset);
    const reset=await post({action:'updateUser',id:'USR-ATTENDANCE',displayName:'출석 담당',role:'일반 담당자',active:true,pin:'13579024'},adminCookie);
    assert.equal(reset.status,200);
    assert.equal((await get(resetCookie)).status,401);

    const temporaryLogin=await post({action:'login',username:'attendance',pin:'13579024'}),temporaryCookie=cookieFrom(temporaryLogin);
    const ownPinChange=await post({action:'changeMyPin',currentPin:'13579024',newPin:'24680135'},temporaryCookie);
    assert.equal(ownPinChange.status,200);
    assert.equal((await ownPinChange.json()).loginRequired,true);
    assert.match(ownPinChange.headers.get('set-cookie'),/Max-Age=0/);
    assert.equal((await get(temporaryCookie)).status,401);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE user_id=?').get('USR-ATTENDANCE').count,0);

    const expiredLogin=await post({action:'login',username:'attendance',pin:'24680135'}),expiredCookie=cookieFrom(expiredLogin),expiredSecret=expiredCookie.slice(SESSION_COOKIE_NAME.length+1);
    db.prepare('UPDATE auth_sessions SET expires_at=? WHERE token=?').run('2000-01-01T00:00:00.000Z',sessionTokenDigest(expiredSecret));
    const expiredResponse=await get(expiredCookie);
    assert.equal(expiredResponse.status,401);
    assert.match(expiredResponse.headers.get('set-cookie'),/Max-Age=0/);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM auth_sessions WHERE token=?').get(sessionTokenDigest(expiredSecret)).count,0);

    const logoutLogin=await post({action:'login',username:'attendance',pin:'24680135'}),logoutCookie=cookieFrom(logoutLogin);
    const logout=await post({action:'logout'},logoutCookie);
    assert.equal(logout.status,200);
    assert.equal(logout.headers.get('cache-control'),'no-store');
    assert.match(logout.headers.get('set-cookie'),/Max-Age=0/);
    const reused=await get(logoutCookie);
    assert.equal(reused.status,401);
    console.log(JSON.stringify({ok:true}));
  `;
  try {
    const result=runNode(source,{
      NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975',
      ONMAEUM_ENABLE_DEMO_SEED:'0',
    });
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  } finally {rmSync(directory,{recursive:true,force:true});}
});
