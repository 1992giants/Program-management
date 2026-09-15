import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import { CURRENT_SCHEMA_VERSION, classifyKnownV0Schema, createLatestSchema, migrateKnownV0Schema, schemaFingerprint, validateLatestSchema } from './schema-management.ts';
import { createVerifiedBackup } from './backup-management.ts';

export { CURRENT_SCHEMA_VERSION } from './schema-management.ts';

let database: DatabaseSync | null = null;
let fatalDatabaseState:Error|null=null;
const APPLICATION_ID='onmaeum-program-care';

export function markDatabaseUnusable(error:unknown){
  fatalDatabaseState=new Error('Database state is uncertain; process restart is required.',{cause:error});
  console.error('[database] marked unusable',error);
  try {database?.close();}catch(closeError){console.error('[database] close after fatal state failed',closeError);}
}

export function withImmediateTransaction<T>(db:DatabaseSync,fn:()=>T):T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result=fn();
    db.exec('COMMIT');
    return result;
  } catch(error) {
    try { db.exec('ROLLBACK'); } catch {}
    throw error;
  }
}

type DatabaseEnvironment='production'|'development'|'test';

function databaseEnvironment():DatabaseEnvironment {
  return process.env.NODE_ENV==='production'?'production':process.env.NODE_ENV==='test'?'test':'development';
}

export function getDatabasePath() {
  const environment=databaseEnvironment();
  const configuredPath=(environment==='production'?process.env.ONMAEUM_DB_PATH:environment==='test'?process.env.ONMAEUM_TEST_DB_PATH:process.env.ONMAEUM_DEV_DB_PATH)?.trim();
  if (environment === 'production' && !configuredPath) {
    throw new Error('운영 환경에서는 ONMAEUM_DB_PATH에 서버 PC의 로컬 DB 절대경로를 명시해야 합니다.');
  }
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new Error('현재 환경의 DB 경로는 절대경로여야 합니다.');
  }
  return configuredPath
    ? path.resolve(/* turbopackIgnore: true */ configuredPath)
    : path.join(/* turbopackIgnore: true */ process.cwd(), 'data',environment==='test'?'test.sqlite':'development.sqlite');
}

export function getBackupDirectory() {
  const configuredPath = process.env.ONMAEUM_BACKUP_DIR;
  return configuredPath
    ? path.resolve(/* turbopackIgnore: true */ configuredPath)
    : path.join(/* turbopackIgnore: true */ path.dirname(getDatabasePath()), 'backups');
}

export function getStorageInfo() {
  const databasePath=getDatabasePath(),backupDirectory=getBackupDirectory();
  const networkPath=/^(\\\\|\/\/)/.test(databasePath);
  return {databasePath,backupDirectory,networkPath,journalMode:'DELETE',architecture:'단일 서버 프로세스'};
}

export function getDatabase() {
  if(fatalDatabaseState)throw fatalDatabaseState;
  if (database) return database;
  const environment=databaseEnvironment(),filePath=getDatabasePath(),networkPath=/^(\\\\|\/\/)/.test(filePath);
  const initializeProduction=process.env.ONMAEUM_INITIALIZE_PRODUCTION_DB==='1';
  if(environment==='production'&&networkPath)throw new Error('운영 SQLite DB는 네트워크 공유 경로에 둘 수 없습니다. ONMAEUM_ALLOW_NETWORK_DB는 production에서 적용되지 않습니다.');
  const fileExisted=existsSync(filePath);
  if(environment==='production'&&!fileExisted&&!initializeProduction)throw new Error('운영 DB 파일이 존재하지 않습니다. 경로를 확인하세요. 신규 DB는 명시적인 production 초기화 모드에서만 생성할 수 있습니다.');
  if(environment==='production'&&fileExisted&&initializeProduction)throw new Error('production 초기화 모드는 새 DB 파일에만 사용할 수 있습니다. 기존 DB로 실행할 때는 초기화 모드를 해제하세요.');
  if (networkPath && process.env.ONMAEUM_ALLOW_NETWORK_DB !== '1') {
    throw new Error('실시간 SQLite 파일은 네트워크 공유 경로에 둘 수 없습니다. 서버 PC의 로컬 경로를 사용하고 외장·네트워크 드라이브는 백업 경로로 지정하세요.');
  }
  if(environment==='production'&&fileExisted&&process.env.ONMAEUM_ADOPT_PRODUCTION_DB==='1')adoptProductionDatabaseExplicitly();
  if(environment==='production'&&fileExisted&&process.env.ONMAEUM_MIGRATE_USR_ADMIN==='1')migrateLegacyAdministratorExplicitly();
  if(!fileExisted)mkdirSync(path.dirname(filePath), { recursive: true });
  if(environment!=='production'||initializeProduction)mkdirSync(getBackupDirectory(), { recursive: true });
  const candidate = new DatabaseSync(filePath);
  try {
    configureConnection(candidate,{setJournalMode:!fileExisted});
    if(!fileExisted){
      withImmediateTransaction(candidate,()=>{
        createLatestSchema(candidate);
        bootstrapBaselineData(candidate);
        bootstrapInitialAdministrator(candidate,new Date().toISOString().slice(0,10),{allowInitialAdministrator:true,migrateUsrAdmin:false});
        writeDatabaseMarkers(candidate,environment);
        if(environment!=='production'&&process.env.ONMAEUM_ENABLE_DEMO_SEED==='1')seedDatabase(candidate);
      });
    } else if(environment!=='production'&&Number((candidate.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)===0){
      migrateKnownV0Schema(candidate);
    }
    if(environment!=='production'&&fileExisted){
      bootstrapBaselineData(candidate);
      bootstrapInitialAdministrator(candidate,new Date().toISOString().slice(0,10),{allowInitialAdministrator:true,migrateUsrAdmin:process.env.ONMAEUM_MIGRATE_USR_ADMIN==='1'});
      const participantCount=(candidate.prepare('SELECT COUNT(*) AS count FROM participants').get() as {count:number}).count;
      if(process.env.ONMAEUM_ENABLE_DEMO_SEED==='1'&&!participantCount)withImmediateTransaction(candidate,()=>seedDatabase(candidate));
    }
    validateLatestSchema(candidate);
    validateDatabaseIdentity(candidate,environment);
    validateActiveAdministrator(candidate);
    rejectUnreviewedLegacyAdministrator(candidate);
    database=candidate;
    return database;
  } catch(error) {
    candidate.close();
    if(!fileExisted){rmSync(filePath,{force:true});rmSync(`${filePath}-journal`,{force:true});}
    throw error;
  }
}

function configureConnection(db:DatabaseSync,{setJournalMode=false}:{setJournalMode?:boolean}={}){
  db.exec('PRAGMA foreign_keys = ON');
  if(setJournalMode)db.exec('PRAGMA journal_mode = DELETE');
  db.exec('PRAGMA synchronous = FULL');
  db.exec('PRAGMA busy_timeout = 5000');
  const foreignKeys=Number((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys);
  if(foreignKeys!==1)throw new Error('SQLite foreign_keys must be enabled.');
}

function marker(db:DatabaseSync,key:string){return (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value}

function validateDatabaseIdentity(db:DatabaseSync,environment:DatabaseEnvironment){
  const applicationId=marker(db,'application_id'),storedEnvironment=marker(db,'database_environment');
  if(!applicationId||!storedEnvironment)throw new Error('기존 marker 없는 DB입니다. 명시적인 production DB adoption 절차가 필요합니다.');
  const required=['settings','participants','programs','program_runs','sessions','applications','attendance','staff_users','auth_sessions'];
  if(applicationId&&applicationId!==APPLICATION_ID)throw new Error('다른 애플리케이션의 SQLite 파일은 열 수 없습니다.');
  if(storedEnvironment&&storedEnvironment!==environment)throw new Error(`${storedEnvironment} DB를 ${environment} 환경에서 열 수 없습니다.`);
  const tables=new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
  const missing=required.filter(table=>!tables.has(table));
  if(missing.length)throw new Error(`Onmaeum DB 필수 테이블이 누락되었습니다: ${missing.join(', ')}`);
}

function writeDatabaseMarkers(db:DatabaseSync,environment:DatabaseEnvironment) {
  const set=db.prepare('INSERT INTO settings (key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value');
  set.run('application_id',APPLICATION_ID);
  set.run('database_environment',environment);
  set.run('database_initialized_at',new Date().toISOString());
}

function bootstrapBaselineData(db:DatabaseSync){
  const center = db.prepare('SELECT value FROM settings WHERE key = ?').get('center_name');
  if (!center) {
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('center_name', '마음봄 정신건강복지센터');
    db.prepare('INSERT INTO settings (key, value) VALUES (?, ?)').run('manager_name', '프로그램 담당자');
  }
  const seedDate=new Date().toISOString().slice(0,10);
  const insertAssessment=db.prepare('INSERT OR IGNORE INTO assessment_catalog (id,name,min_score,max_score,active,created_at) VALUES (?,?,?,?,1,?)');
  insertAssessment.run('ASM-PHQ9','PHQ-9',0,27,seedDate);
  insertAssessment.run('ASM-GAD7','GAD-7',0,21,seedDate);
  insertAssessment.run('ASM-PSS10','PSS-10',0,40,seedDate);
}

function validateActiveAdministrator(db:DatabaseSync){
  const administrators=(db.prepare("SELECT COUNT(*) AS count FROM staff_users WHERE role='관리자' AND active=1").get() as {count:number}).count;
  if(administrators<1)throw new Error('An active production administrator is required.');
}

function validateBaselineData(db:DatabaseSync){
  for(const key of ['center_name','manager_name'])if(!marker(db,key)?.trim())throw new Error(`Required production setting is missing: ${key}.`);
  const assessments=(db.prepare("SELECT COUNT(*) AS count FROM assessment_catalog WHERE id IN ('ASM-PHQ9','ASM-GAD7','ASM-PSS10')").get() as {count:number}).count;
  if(assessments!==3)throw new Error('Required baseline assessment catalog entries are missing.');
}

function rejectUnreviewedLegacyAdministrator(db:DatabaseSync){
  const legacy=db.prepare('SELECT id FROM staff_users WHERE id=?').get('USR-ADMIN');
  if(legacy&&marker(db,'usr_admin_migration_completed')!=='1')throw new Error('기존 USR-ADMIN 계정이 발견되었습니다. 백업 후 명시적인 USR-ADMIN migration 절차를 수행하세요.');
}

function bootstrapCredentials() {
  const username=process.env.ONMAEUM_BOOTSTRAP_ADMIN_USERNAME?.trim().toLowerCase();
  const displayName=process.env.ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME?.trim();
  const pin=process.env.ONMAEUM_BOOTSTRAP_ADMIN_PIN?.trim();
  if(!username||!displayName||!pin)throw new Error('ONMAEUM_BOOTSTRAP_ADMIN_USERNAME, ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME, ONMAEUM_BOOTSTRAP_ADMIN_PIN을 모두 설정해야 합니다.');
  if(pin.length<8||/^([0-9])\1+$/.test(pin))throw new Error('관리자 PIN은 반복 숫자가 아닌 8자리 이상이어야 합니다.');
  return {username,displayName,pin};
}

function bootstrapInitialAdministrator(db:DatabaseSync,createdAt:string,options:{allowInitialAdministrator:boolean;migrateUsrAdmin:boolean}) {
  const userCount=db.prepare('SELECT COUNT(*) AS count FROM staff_users').get() as {count:number};
  const legacyAutomaticAccount=db.prepare('SELECT id FROM staff_users WHERE id=?').get('USR-ADMIN') as {id:string}|undefined;
  const legacyReviewed=(db.prepare('SELECT value FROM settings WHERE key=?').get('usr_admin_migration_completed') as {value:string}|undefined)?.value==='1';
  if(legacyAutomaticAccount&&!legacyReviewed){
    if(!options.migrateUsrAdmin)throw new Error('기존 USR-ADMIN 계정이 발견되었습니다. 자동 교체하지 않았습니다. 백업 후 명시적인 USR-ADMIN migration 절차를 수행하세요.');
    const {username,displayName,pin}=bootstrapCredentials();
    db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('DELETE FROM auth_sessions WHERE user_id=?').run(legacyAutomaticAccount.id);
      db.prepare(`UPDATE staff_users SET username=?,display_name=?,pin_hash=?,role='관리자',active=1,pin_changed_at=NULL,must_change_pin=1,failed_attempts=0,locked_until=NULL WHERE id=?`).run(username,displayName,hashPin(username,pin),legacyAutomaticAccount.id);
      db.prepare(`INSERT INTO settings (key,value) VALUES ('usr_admin_migration_completed','1') ON CONFLICT(key) DO UPDATE SET value='1'`).run();
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
    return;
  }
  if(userCount.count)return;
  if(!options.allowInitialAdministrator)throw new Error('운영 DB에 관리자 계정이 없습니다. 일반 서버 실행에서는 관리자를 자동 생성하지 않습니다.');
  const {username,displayName,pin}=bootstrapCredentials();
  db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,pin_changed_at,must_change_pin) VALUES (?,?,?,?,?,1,?,NULL,1)').run(`USR-${randomUUID()}`,username,displayName,hashPin(username,pin),'관리자',createdAt);
}

function assertProductionDatabasePath(){
  if(databaseEnvironment()!=='production')throw new Error('Production database maintenance requires NODE_ENV=production.');
  const filePath=getDatabasePath();
  if(/^(\\\\|\/\/)/.test(filePath))throw new Error('운영 SQLite DB는 네트워크 공유 경로에 둘 수 없습니다.');
  return filePath;
}

function integrityCheck(db:DatabaseSync){
  const rows=db.prepare('PRAGMA integrity_check').all() as {integrity_check:string}[];
  if(rows.length!==1||rows[0].integrity_check!=='ok')throw new Error('SQLite integrity_check failed.');
}

function validateProductionJournalMode(db:DatabaseSync){
  const journalMode=String((db.prepare('PRAGMA journal_mode').get() as {journal_mode:string}).journal_mode).toLowerCase();
  if(journalMode!=='delete')throw new Error(`Production SQLite journal_mode must be DELETE; found ${journalMode}.`);
}

function validateProductionState(db:DatabaseSync,{integrity=false,allowLegacyAdministrator=false}:{integrity?:boolean;allowLegacyAdministrator?:boolean}={}){
  if(integrity)integrityCheck(db);
  validateProductionJournalMode(db);
  const schema=validateLatestSchema(db);
  validateDatabaseIdentity(db,'production');
  validateActiveAdministrator(db);
  validateBaselineData(db);
  if(!allowLegacyAdministrator)rejectUnreviewedLegacyAdministrator(db);
  return schema;
}

export function validateProductionDatabaseReadOnly(){
  const filePath=assertProductionDatabasePath();
  if(!existsSync(filePath))throw new Error('운영 DB 파일이 존재하지 않습니다.');
  const db=new DatabaseSync(filePath,{readOnly:true});
  try {
    db.exec('PRAGMA query_only = ON');
    db.exec('PRAGMA foreign_keys = ON');
    const schema=validateProductionState(db,{integrity:true});
    return {...schema,integrity:'ok' as const,productionMarker:true as const,activeAdministrator:true as const};
  } finally {db.close()}
}

export function adoptProductionDatabaseExplicitly(){
  const filePath=assertProductionDatabasePath();
  if(!existsSync(filePath))throw new Error('adopt 대상 운영 DB 파일이 존재하지 않습니다.');
  const db=new DatabaseSync(filePath);
  try {
    configureConnection(db);
    integrityCheck(db);
    const tables=new Set((db.prepare("SELECT name FROM sqlite_schema WHERE type='table'").all() as {name:string}[]).map(row=>row.name));
    if(!tables.has('settings'))throw new Error('지정한 파일은 Onmaeum DB로 확인되지 않습니다.');
    const applicationId=marker(db,'application_id'),storedEnvironment=marker(db,'database_environment');
    if(applicationId&&applicationId!==APPLICATION_ID)throw new Error('다른 애플리케이션의 SQLite 파일은 adopt할 수 없습니다.');
    if(storedEnvironment&&storedEnvironment!=='production')throw new Error(`${storedEnvironment} DB를 production 환경에서 열 수 없습니다. adopt를 거부했습니다.`);
    const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    const schema=version===CURRENT_SCHEMA_VERSION?validateLatestSchema(db):{version,profile:classifyKnownV0Schema(db),fingerprint:schemaFingerprint(db)};
    validateActiveAdministrator(db);
    withImmediateTransaction(db,()=>writeDatabaseMarkers(db,'production'));
    return {...schema,adopted:true as const};
  } finally {db.close()}
}

export function migrateLegacyAdministratorExplicitly(){
  const filePath=assertProductionDatabasePath();
  if(!existsSync(filePath))throw new Error('USR-ADMIN migration 대상 운영 DB 파일이 존재하지 않습니다.');
  const db=new DatabaseSync(filePath);
  try {
    configureConnection(db);
    validateProductionState(db,{integrity:true,allowLegacyAdministrator:true});
    bootstrapInitialAdministrator(db,new Date().toISOString().slice(0,10),{allowInitialAdministrator:false,migrateUsrAdmin:true});
    validateProductionState(db,{integrity:true});
    if(marker(db,'usr_admin_migration_completed')!=='1')throw new Error('USR-ADMIN migration completion marker is missing.');
    return {migrated:true as const};
  } finally {db.close()}
}

export async function migrateProductionSchemaExplicitly(){
  const filePath=assertProductionDatabasePath();
  if(!existsSync(filePath))throw new Error('migrate-schema 대상 운영 DB 파일이 존재하지 않습니다.');
  const db=new DatabaseSync(filePath);
  let safetyBackup:string|null=null;
  try {
    configureConnection(db);
    integrityCheck(db);
    validateProductionJournalMode(db);
    validateDatabaseIdentity(db,'production');
    validateActiveAdministrator(db);
    validateBaselineData(db);
    const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(version===CURRENT_SCHEMA_VERSION){
      const schema=validateLatestSchema(db);
      return {...schema,alreadyCurrent:true as const,safetyBackup:null};
    }
    if(version>CURRENT_SCHEMA_VERSION)throw new Error(`Database schema version ${version} is newer than application version ${CURRENT_SCHEMA_VERSION}; downgrade is refused.`);
    const profile=classifyKnownV0Schema(db),beforeFingerprint=schemaFingerprint(db);
    const safety=await createVerifiedBackup(db,{sourceDatabasePath:filePath,backupDirectory:getBackupDirectory(),purpose:'migration_safety',expectedSource:{version:0,fingerprint:beforeFingerprint}});
    safetyBackup=safety.artifact.basename;
    for(const warning of safety.retentionWarnings)console.warn(warning);
    const migrated=migrateKnownV0Schema(db);
    validateProductionState(db,{allowLegacyAdministrator:true});
    return {...migrated,profile,safetyBackup,alreadyCurrent:false as const};
  } finally {db.close()}
}

function seedDatabase(db: DatabaseSync) {
  const today = '2026-08-24';
  const participantRows = [
    ['P-2026-0001','김민준','남성',35,'010-2415-9181','회원','불안 완화 프로그램에 관심',today],
    ['P-2026-0002','이서연','여성',39,'010-5822-3120','회원','오후 시간 선호',today],
    ['P-2026-0003','박지훈','남성',30,'010-9164-5544','비회원','첫 이용',today],
    ['P-2026-0004','최은영','여성',46,'010-3721-9906','회원','보호자 동행 가능',today],
  ];
  const insertParticipant = db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)');
  for (const row of participantRows) insertParticipant.run(...row);
  const programRows = [
    ['PRG-001','마음챙김 명상교실','정서회복','집단',3,'매월','프로그램실 A','이지은',10,'운영 중',today],
    ['PRG-002','개별 회복 코칭','개별상담','1:1',4,'매주','상담실 2','박서준',1,'운영 중',today],
    ['PRG-003','함께 걷는 회복 산책','신체활동','집단',2,'매월','센터 앞 공원','김하늘',15,'운영 중',today],
  ];
  const insertProgram = db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)');
  for (const row of programRows) insertProgram.run(...row);
  createRun(db,'PRG-001',1,'2026년 8월 1차','2026-08-05','10:00');
  createRun(db,'PRG-001',2,'2026년 9월 2차','2026-09-02','10:00');
  createRun(db,'PRG-002',1,'김민준 1차','2026-08-07','14:00');
  createRun(db,'PRG-003',1,'2026년 8월 1차','2026-08-12','15:00');
  const insertApplication = db.prepare('INSERT INTO applications (participant_id,program_id,run_id,applied_at,status) VALUES (?,?,?,?,?)');
  insertApplication.run('P-2026-0001','PRG-001','RUN-PRG-001-1','2026-07-25','참가중');
  insertApplication.run('P-2026-0002','PRG-001','RUN-PRG-001-1','2026-07-26','참가중');
  insertApplication.run('P-2026-0003','PRG-001',null,'2026-08-20','신청');
  insertApplication.run('P-2026-0001','PRG-002','RUN-PRG-002-1','2026-08-01','참가중');
  insertApplication.run('P-2026-0004','PRG-003','RUN-PRG-003-1','2026-08-03','참가대기');
}

export function createRun(db: DatabaseSync, programId:string, roundNumber:number, label:string, startDate:string, time:string) {
  const program = db.prepare('SELECT session_count, recurrence, location FROM programs WHERE id=?').get(programId) as {session_count:number;recurrence:string;location:string};
  const runId = `RUN-${programId}-${roundNumber}`;
  db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run(runId,programId,roundNumber,label,startDate,'모집 중');
  const insert = db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)');
  for (let i=1;i<=program.session_count;i++) {
    const date = addInterval(startDate, i-1, program.recurrence);
    insert.run(`${runId}-S${i}`,runId,i,date,time,program.location);
  }
  return runId;
}

function addInterval(startDate:string, offset:number, recurrence:string) {
  const date = new Date(`${startDate}T00:00:00`);
  if (recurrence === '매일') date.setDate(date.getDate()+offset);
  else if (recurrence === '매월') date.setMonth(date.getMonth()+offset);
  else date.setDate(date.getDate()+offset*7);
  return date.toISOString().slice(0,10);
}

export function databaseExists() { return existsSync(getDatabasePath()); }
function legacyPinHash(username:string,pin:string) { return createHash('sha256').update(`onmaeum-local|${username.trim().toLowerCase()}|${pin}`).digest('hex'); }
export function hashPin(username:string,pin:string) { const salt=randomBytes(16).toString('hex');return `scrypt$${salt}$${scryptSync(pin,`onmaeum-local|${username.trim().toLowerCase()}|${salt}`,32).toString('hex')}`; }
export function verifyPin(username:string,pin:string,stored:string) {
  if(!stored.startsWith('scrypt$'))return stored===legacyPinHash(username,pin);
  const parts=stored.split('$'),salt=parts.length===3?`onmaeum-local|${username.trim().toLowerCase()}|${parts[1]}`:`onmaeum-local|${username.trim().toLowerCase()}`,hash=parts.length===3?parts[2]:parts[1];
  const expected=Buffer.from(hash,'hex'),actual=scryptSync(pin,salt,32);
  return expected.length===actual.length&&timingSafeEqual(expected,actual);
}
