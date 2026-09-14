import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { getTableConfig } from 'drizzle-orm/sqlite-core';

import { CURRENT_SCHEMA_VERSION } from '../db/index.ts';
import { LATEST_SCHEMA_COLUMN_MANIFEST, LATEST_SCHEMA_COLUMNS, classifyKnownV0Schema, migrateKnownV0Schema, validateLatestSchema } from '../db/schema-management.ts';
import * as declaredSchema from '../db/schema.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');
const credentials={ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'schema-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'스키마 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'86420975'};

function productionEnv(databasePath,backupDirectory){return {...process.env,NODE_ENV:'production',ONMAEUM_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory,...credentials}}
function runProduction(modes,databasePath,backupDirectory){return spawnSync(process.execPath,['--experimental-strip-types','scripts/production-database.mjs',...modes],{cwd:projectRoot,env:productionEnv(databasePath,backupDirectory),encoding:'utf8'})}
function runStartup(databasePath,backupDirectory){return spawnSync(process.execPath,['--input-type=module','--eval',"import { getDatabase } from './db/index.ts'; const db=getDatabase(); console.log(JSON.stringify({version:db.prepare('PRAGMA user_version').get().user_version,foreignKeys:db.prepare('PRAGMA foreign_keys').get().foreign_keys}));"],{cwd:projectRoot,env:productionEnv(databasePath,backupDirectory),encoding:'utf8'})}
function initialize(databasePath,backupDirectory){const result=runProduction(['initialize'],databasePath,backupDirectory);assert.equal(result.status,0,result.stderr||result.stdout)}
function hashFile(file){return createHash('sha256').update(readFileSync(file)).digest('hex')}
function rawColumnDetails(db,table){return db.prepare(`PRAGMA table_info("${table}")`).all().map(row=>({name:row.name,type:row.type.trim().toUpperCase(),pk:row.pk,notNull:Boolean(row.notnull),normalizedDefault:row.dflt_value===null?null:row.dflt_value.trim()}))}
function semanticState(databasePath){
  const db=new DatabaseSync(databasePath,{readOnly:true});
  try{
    const tables=['settings','participants','programs','program_runs','sessions','applications','attendance','staff_users','assessment_catalog'];
    const data=Object.fromEntries(tables.map(table=>[table,db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()]));
    return {version:db.prepare('PRAGMA user_version').get().user_version,schema:db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type,name").all(),rows:Object.fromEntries(tables.map(table=>[table,data[table].length])),dataHash:createHash('sha256').update(JSON.stringify(data)).digest('hex')};
  }finally{db.close()}
}
function rebuildTable(databasePath,table,transform){
  const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=OFF');
  try{
    const source=db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name=?").get(table)?.sql;
    assert.ok(source,`missing CREATE TABLE SQL for ${table}`);
    const indexSql=db.prepare("SELECT sql FROM sqlite_schema WHERE type='index' AND tbl_name=? AND sql IS NOT NULL ORDER BY name").all(table).map(row=>row.sql);
    const columnNames=db.prepare(`PRAGMA table_info("${table}")`).all().map(row=>row.name);
    const temporary=`${table}_malformed`;
    const renamed=source.replace(new RegExp(`^CREATE TABLE\\s+(?:IF NOT EXISTS\\s+)?(?:"${table}"|\\[${table}\\]|${table})`,'i'),`CREATE TABLE "${temporary}"`);
    const malformed=transform(renamed);
    assert.notEqual(malformed,renamed,`schema transform did not change ${table}`);
    const selected=columnNames.map(name=>`"${name}"`).join(',');
    db.exec('BEGIN IMMEDIATE');
    try{
      db.exec(malformed);
      db.exec(`INSERT INTO "${temporary}" (${selected}) SELECT ${selected} FROM "${table}"`);
      db.exec(`DROP TABLE "${table}"`);
      db.exec(`ALTER TABLE "${temporary}" RENAME TO "${table}"`);
      for(const sql of indexSql)db.exec(sql);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error}
  }finally{db.exec('PRAGMA foreign_keys=ON');db.close()}
}
function downgradeToKnownV0(databasePath){
  const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=OFF; BEGIN IMMEDIATE');
  try{
    db.exec('DROP INDEX idx_attendance_makeup_session; DROP INDEX idx_certificates_participant; DROP INDEX idx_applications_program_run;');
    db.exec(`CREATE TABLE attendance_v0 (id INTEGER PRIMARY KEY AUTOINCREMENT,application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,status TEXT NOT NULL DEFAULT '미입력',note TEXT NOT NULL DEFAULT '',contacted_at TEXT,makeup_for_session_id TEXT,UNIQUE(application_id,session_id)); INSERT INTO attendance_v0 SELECT * FROM attendance; DROP TABLE attendance; ALTER TABLE attendance_v0 RENAME TO attendance; CREATE INDEX idx_attendance_application ON attendance(application_id); CREATE INDEX idx_attendance_session ON attendance(session_id); PRAGMA user_version=0; COMMIT;`);
  }catch(error){db.exec('ROLLBACK');throw error}finally{db.exec('PRAGMA foreign_keys=ON');db.close()}
}
function removeProductionMarkers(databasePath){const db=new DatabaseSync(databasePath);try{db.exec("DELETE FROM settings WHERE key IN ('application_id','database_environment')")}finally{db.close()}}
function seedAttendanceData(databasePath,{orphan=false}={}){
  const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON');
  db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-SCHEMA','테스트 참가자','미입력',0,'','비회원','','2026-09-14')").run();
  db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES ('PRG-SCHEMA','테스트 프로그램','테스트','집단',2,'매주','','',10,'운영 중','2026-09-14')").run();
  db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES ('RUN-SCHEMA','PRG-SCHEMA',1,'1차','2026-09-14','진행 중')").run();
  db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES ('SESSION-A','RUN-SCHEMA',1,'2026-09-14','10:00','')").run();
  db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES ('SESSION-B','RUN-SCHEMA',2,'2026-09-21','10:00','')").run();
  const applicationId=Number(db.prepare("INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES ('P-SCHEMA','PRG-SCHEMA','RUN-SCHEMA','2026-09-14','참가중',1,'2026-09-14')").run().lastInsertRowid);
  db.prepare('INSERT INTO attendance (application_id,session_id,status,note,makeup_for_session_id) VALUES (?,?,?,?,?)').run(applicationId,'SESSION-A','보강','보존 메모',orphan?'MISSING-SESSION':'SESSION-B');
  db.close();
}

test('new production DB is created directly at the latest version and declared schema stays synchronized',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-latest-')),databasePath=path.join(directory,'production.sqlite'),backupDirectory=path.join(directory,'backups');
  try{
    initialize(databasePath,backupDirectory);
    const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON');
    assert.equal(db.prepare('PRAGMA user_version').get().user_version,CURRENT_SCHEMA_VERSION);
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
    for(const [table,expected] of Object.entries(LATEST_SCHEMA_COLUMN_MANIFEST))assert.deepEqual(rawColumnDetails(db,table),expected,table);
    const makeupFk=db.prepare("PRAGMA foreign_key_list('attendance')").all().find(row=>row.from==='makeup_for_session_id');
    assert.deepEqual({table:makeupFk.table,to:makeupFk.to,onDelete:makeupFk.on_delete},{table:'sessions',to:'id',onDelete:'SET NULL'});
    for(const name of ['idx_attendance_makeup_session','idx_certificates_participant','idx_applications_program_run'])assert.ok(db.prepare("SELECT 1 FROM sqlite_schema WHERE type='index' AND name=?").get(name));
    db.close();
    const exportsByTable=Object.fromEntries(Object.values(declaredSchema).map(table=>{const config=getTableConfig(table);return [config.name,config.columns.map(column=>column.name)]}));
    assert.deepEqual(exportsByTable,LATEST_SCHEMA_COLUMNS);
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('normal production startup and validate do not mutate a current database',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-readonly-')),databasePath=path.join(directory,'production.sqlite'),backupDirectory=path.join(directory,'backups');
  try{
    initialize(databasePath,backupDirectory);
    seedAttendanceData(databasePath);
    const before=semanticState(databasePath);
    const startup=runStartup(databasePath,backupDirectory);assert.equal(startup.status,0,startup.stderr);assert.deepEqual(JSON.parse(startup.stdout.trim()),{version:CURRENT_SCHEMA_VERSION,foreignKeys:1});assert.deepEqual(semanticState(databasePath),before);
    const beforeHash=hashFile(databasePath),validated=runProduction(['validate'],databasePath,backupDirectory);assert.equal(validated.status,0,validated.stderr);assert.equal(hashFile(databasePath),beforeHash);assert.deepEqual(semanticState(databasePath),before);
    const migrated=runProduction(['migrate-schema'],databasePath,backupDirectory);assert.equal(migrated.status,0,migrated.stderr);assert.equal(JSON.parse(migrated.stdout.trim().split(/\r?\n/).at(-1)).alreadyCurrent,true);assert.deepEqual(semanticState(databasePath),before);
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('known latest-v0 migrates once with data preservation, safety backup, FK and indexes',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-v0-')),databasePath=path.join(directory,'production.sqlite'),backupDirectory=path.join(directory,'backups');
  try{
    initialize(databasePath,backupDirectory);seedAttendanceData(databasePath);downgradeToKnownV0(databasePath);removeProductionMarkers(databasePath);
    const beforeBlockedStartup=semanticState(databasePath);assert.notEqual(runStartup(databasePath,backupDirectory).status,0);assert.deepEqual(semanticState(databasePath),beforeBlockedStartup);
    const adopted=runProduction(['adopt'],databasePath,backupDirectory);assert.equal(adopted.status,0,adopted.stderr||adopted.stdout);
    const migrated=runProduction(['migrate-schema'],databasePath,backupDirectory);assert.equal(migrated.status,0,migrated.stderr||migrated.stdout);
    const result=JSON.parse(migrated.stdout.trim().split(/\r?\n/).at(-1));assert.equal(result.profile,'latest-v0');assert.ok(result.safetyBackup);assert.equal(existsSync(path.join(backupDirectory,result.safetyBackup)),true);
    const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON');assert.equal(db.prepare('PRAGMA user_version').get().user_version,CURRENT_SCHEMA_VERSION);assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);assert.equal(db.prepare('SELECT note FROM attendance').get().note,'보존 메모');
    db.prepare("DELETE FROM sessions WHERE id='SESSION-B'").run();assert.equal(db.prepare('SELECT makeup_for_session_id FROM attendance').get().makeup_for_session_id,null);db.close();
    const before=semanticState(databasePath),again=runProduction(['migrate-schema'],databasePath,backupDirectory);assert.equal(again.status,0,again.stderr);assert.equal(JSON.parse(again.stdout.trim().split(/\r?\n/).at(-1)).alreadyCurrent,true);assert.deepEqual(semanticState(databasePath),before);
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('current schema rejects a NOT NULL mismatch in validator, startup and validate',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-current-nullability-')),databasePath=path.join(directory,'production.sqlite'),backupDirectory=path.join(directory,'backups');
  try{
    initialize(databasePath,backupDirectory);
    rebuildTable(databasePath,'participants',sql=>sql.replace('name TEXT NOT NULL','name TEXT'));
    const db=new DatabaseSync(databasePath,{readOnly:true});try{assert.throws(()=>validateLatestSchema(db),/nullability mismatch: participants\.name/i)}finally{db.close()}
    const before=semanticState(databasePath);assert.notEqual(runStartup(databasePath,backupDirectory).status,0);assert.notEqual(runProduction(['validate'],databasePath,backupDirectory).status,0);assert.deepEqual(semanticState(databasePath),before);
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('current schema rejects changed, missing and unexpected defaults',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-current-default-'));
  try{
    const variants=[
      {name:'changed',table:'participants',transform:sql=>sql.replace("gender TEXT NOT NULL DEFAULT '미입력'","gender TEXT NOT NULL DEFAULT '변경됨'")},
      {name:'missing',table:'participants',transform:sql=>sql.replace("gender TEXT NOT NULL DEFAULT '미입력'",'gender TEXT NOT NULL')},
      {name:'unexpected',table:'applications',transform:sql=>sql.replace('run_id TEXT REFERENCES','run_id TEXT DEFAULT \'unexpected\' REFERENCES')},
    ];
    for(const variant of variants){
      const databasePath=path.join(directory,`${variant.name}.sqlite`),backupDirectory=path.join(directory,`${variant.name}-backups`);initialize(databasePath,backupDirectory);rebuildTable(databasePath,variant.table,variant.transform);
      const db=new DatabaseSync(databasePath,{readOnly:true});try{assert.throws(()=>validateLatestSchema(db),/default mismatch/i,variant.name)}finally{db.close()}
      const before=semanticState(databasePath);assert.notEqual(runStartup(databasePath,backupDirectory).status,0,variant.name);assert.notEqual(runProduction(['validate'],databasePath,backupDirectory).status,0,variant.name);assert.deepEqual(semanticState(databasePath),before,variant.name);
    }
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('known v0 rejects NOT NULL and DEFAULT mismatches before adopt or migration',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-v0-column-metadata-'));
  try{
    const variants=[
      {name:'nullability',table:'participants',transform:sql=>sql.replace('name TEXT NOT NULL','name TEXT')},
      {name:'default',table:'attendance',transform:sql=>sql.replace("status TEXT NOT NULL DEFAULT '미입력'","status TEXT NOT NULL DEFAULT '변경됨'")},
    ];
    for(const variant of variants){
      const databasePath=path.join(directory,`${variant.name}.sqlite`),backupDirectory=path.join(directory,`${variant.name}-backups`);initialize(databasePath,backupDirectory);seedAttendanceData(databasePath);downgradeToKnownV0(databasePath);removeProductionMarkers(databasePath);rebuildTable(databasePath,variant.table,variant.transform);
      const db=new DatabaseSync(databasePath,{readOnly:true});assert.throws(()=>classifyKnownV0Schema(db),/Unknown or partially migrated schema version 0/);db.close();
      const before=semanticState(databasePath);assert.notEqual(runProduction(['adopt'],databasePath,backupDirectory).status,0,variant.name);assert.notEqual(runProduction(['migrate-schema'],databasePath,backupDirectory).status,0,variant.name);assert.deepEqual(semanticState(databasePath),before,variant.name);
      assert.equal(existsSync(backupDirectory)?readdirSync(backupDirectory).length:0,0,variant.name);
    }
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('SQLite metadata distinguishes no DEFAULT from DEFAULT NULL',()=>{
  const db=new DatabaseSync(':memory:');
  try{db.exec('CREATE TABLE default_semantics (without_default TEXT, explicit_null TEXT DEFAULT NULL)');const details=db.prepare('PRAGMA table_info(default_semantics)').all();assert.equal(details[0].dflt_value,null);assert.equal(details[1].dflt_value,'NULL')}
  finally{db.close()}
});

test('unknown, higher, malformed and orphan schemas fail closed without version changes',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-reject-'));
  try{
    for(const variant of ['unknown','higher','malformed','orphan']){
      const databasePath=path.join(directory,`${variant}.sqlite`),backupDirectory=path.join(directory,`${variant}-backups`);initialize(databasePath,backupDirectory);
      if(variant==='orphan'){seedAttendanceData(databasePath);downgradeToKnownV0(databasePath);const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=OFF');db.prepare("UPDATE attendance SET makeup_for_session_id='MISSING-SESSION'").run();db.close()}
      else {const db=new DatabaseSync(databasePath);if(variant==='unknown'){downgradeToKnownV0(databasePath);db.close();const changed=new DatabaseSync(databasePath);changed.exec('ALTER TABLE participants ADD COLUMN unexpected_partial TEXT');changed.close()}else if(variant==='higher'){db.exec(`PRAGMA user_version=${CURRENT_SCHEMA_VERSION+1}`);db.close()}else{db.exec('DROP INDEX idx_applications_program_run');db.close()}}
      const beforeVersion=new DatabaseSync(databasePath,{readOnly:true});const version=beforeVersion.prepare('PRAGMA user_version').get().user_version;beforeVersion.close();
      assert.notEqual(runStartup(databasePath,backupDirectory).status,0,variant);
      assert.notEqual(runProduction(['validate'],databasePath,backupDirectory).status,0,variant);
      assert.notEqual(runProduction(['migrate-schema'],databasePath,backupDirectory).status,0,variant);
      const after=new DatabaseSync(databasePath,{readOnly:true});assert.equal(after.prepare('PRAGMA user_version').get().user_version,version,variant);if(variant==='orphan')assert.equal(after.prepare('SELECT makeup_for_session_id FROM attendance').get().makeup_for_session_id,'MISSING-SESSION');after.close();
    }
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('migration failure rolls back schema and data and restores foreign_keys',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schema-rollback-')),databasePath=path.join(directory,'production.sqlite'),backupDirectory=path.join(directory,'backups');
  try{
    initialize(databasePath,backupDirectory);seedAttendanceData(databasePath);downgradeToKnownV0(databasePath);
    const db=new DatabaseSync(databasePath);db.exec('PRAGMA foreign_keys=ON; CREATE VIEW attendance_new AS SELECT 1 AS value');const before=semanticState(databasePath);
    assert.throws(()=>migrateKnownV0Schema(db));assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys,1);assert.equal(db.prepare('PRAGMA user_version').get().user_version,0);db.close();assert.deepEqual(semanticState(databasePath),before);
    const failed=runProduction(['migrate-schema'],databasePath,backupDirectory);assert.notEqual(failed.status,0);assert.ok(readdirSync(backupDirectory).some(name=>name.includes('before-schema-v')));assert.deepEqual(semanticState(databasePath),before);
  }finally{rmSync(directory,{recursive:true,force:true})}
});
