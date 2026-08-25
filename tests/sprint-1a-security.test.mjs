import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import { hashPin, verifyPin } from '../db/index.ts';
import { attendanceOnlySnapshot, canPerformAction, createAuthSession, getAuthenticatedUser, invalidateAuthSession } from '../lib/security.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');

function runNode(source,env={}) {
  return spawnSync(process.execPath,['--input-type=module','--eval',source],{
    cwd:projectRoot,
    env:{...process.env,...env},
    encoding:'utf8',
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

test('빈 DB는 bootstrap 설정이 없으면 반복 요청에서도 운영 가능 상태가 되지 않는다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-no-bootstrap-'));
  const databasePath=path.join(directory,'production.sqlite');
  try {
    const result=runNode(`
      import { DatabaseSync } from 'node:sqlite';
      import { getDatabase } from './db/index.ts';
      const errors=[];
      for(let attempt=0;attempt<2;attempt+=1){try{getDatabase()}catch(error){errors.push(error.message)}}
      const raw=new DatabaseSync(process.env.ONMAEUM_DB_PATH,{readOnly:true});
      const users=raw.prepare('SELECT COUNT(*) AS count FROM staff_users').get().count;
      raw.close();
      console.log(JSON.stringify({errors,users}));
    `,{NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'',ONMAEUM_BOOTSTRAP_ADMIN_PIN:''});
    assert.equal(result.status,0,result.stderr);
    const checked=JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(checked.errors.length,2);
    assert.equal(checked.users,0);
  } finally { rmSync(directory,{recursive:true,force:true}); }
});

test('production 빈 DB는 명시적 관리자만 bootstrap하고 dummy 또는 admin\/1234를 만들지 않는다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-sprint1a-'));
  const databasePath=path.join(directory,'production.sqlite');
  const source=`
    import { getDatabase } from './db/index.ts';
    const db=getDatabase();
    const result={
      participants:db.prepare('SELECT COUNT(*) AS count FROM participants').get().count,
      programs:db.prepare('SELECT COUNT(*) AS count FROM programs').get().count,
      users:db.prepare('SELECT username,must_change_pin,pin_hash FROM staff_users').all(),
    };
    console.log(JSON.stringify(result));
  `;
  try {
    const first=runNode(source,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
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
    assert.match(created.users[0].pin_hash,/^scrypt\$/);
    assert.equal(verifyPin('center-owner','1234',created.users[0].pin_hash),false);

    const second=runNode(source,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
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

test('이전 자동 관리자 계정은 bootstrap 자격증명으로 한 번만 교체된다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-legacy-admin-'));
  const databasePath=path.join(directory,'production.sqlite');
  try {
    const create=runNode(`import { getDatabase } from './db/index.ts'; const db=getDatabase(); db.prepare('UPDATE staff_users SET id=?').run('USR-ADMIN');`,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'temporary-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'임시 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975',
    });
    assert.equal(create.status,0,create.stderr);
    const replace=runNode(`import { getDatabase } from './db/index.ts'; const db=getDatabase(); console.log(JSON.stringify(db.prepare('SELECT id,username,must_change_pin FROM staff_users').all()));`,{
      NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),
      ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'rotated-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'교체 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',
    });
    assert.equal(replace.status,0,replace.stderr);
    const users=JSON.parse(replace.stdout.trim().split(/\r?\n/).at(-1));
    assert.equal(users.length,1);
    assert.equal(users[0].username,'rotated-owner');
    assert.notEqual(users[0].id,'USR-ADMIN');
    assert.equal(users[0].must_change_pin,1);
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

test('로그인 검증 후 만든 session은 logout 즉시 재사용할 수 없다',()=>{
  const db=new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE staff_users(id TEXT PRIMARY KEY,username TEXT,display_name TEXT,pin_hash TEXT,role TEXT,active INTEGER,must_change_pin INTEGER,last_login_at TEXT);
    CREATE TABLE auth_sessions(token TEXT PRIMARY KEY,user_id TEXT,expires_at TEXT,created_at TEXT,last_seen_at TEXT,ip_address TEXT);
  `);
  const stored=hashPin('attendance','48261590');
  db.prepare('INSERT INTO staff_users VALUES (?,?,?,?,?,1,0,NULL)').run('U-1','attendance','출석 담당',stored,'출석 입력 전용');
  assert.equal(verifyPin('attendance','48261590',stored),true);
  const session=createAuthSession(db,'U-1','local');
  const request=new Request('http://localhost/api/data',{headers:{Authorization:`Bearer ${session.token}`}});
  assert.equal(getAuthenticatedUser(request,db)?.id,'U-1');
  assert.equal(invalidateAuthSession(request,db),true);
  assert.equal(getAuthenticatedUser(request,db),undefined);
  db.close();
});
