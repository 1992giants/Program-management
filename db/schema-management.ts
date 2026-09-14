import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

export const CURRENT_SCHEMA_VERSION = 1;

export const LATEST_SCHEMA_SQL = `
  CREATE TABLE settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE participants (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    gender TEXT NOT NULL DEFAULT '미입력',
    age INTEGER NOT NULL DEFAULT 0,
    phone TEXT NOT NULL DEFAULT '',
    member_status TEXT NOT NULL DEFAULT '비회원',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  );
  CREATE TABLE programs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    category TEXT NOT NULL,
    delivery_type TEXT NOT NULL DEFAULT '집단',
    session_count INTEGER NOT NULL DEFAULT 1,
    recurrence TEXT NOT NULL DEFAULT '매주',
    location TEXT NOT NULL DEFAULT '',
    manager TEXT NOT NULL DEFAULT '',
    capacity INTEGER NOT NULL DEFAULT 10,
    status TEXT NOT NULL DEFAULT '운영 중',
    created_at TEXT NOT NULL
  );
  CREATE TABLE program_runs (
    id TEXT PRIMARY KEY,
    program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    round_number INTEGER NOT NULL,
    label TEXT NOT NULL,
    start_date TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '모집 중',
    closed_at TEXT,
    closed_by TEXT,
    UNIQUE(program_id, round_number)
  );
  CREATE TABLE sessions (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES program_runs(id) ON DELETE CASCADE,
    session_number INTEGER NOT NULL,
    session_date TEXT NOT NULL,
    session_time TEXT NOT NULL,
    location TEXT NOT NULL,
    attendance_status TEXT NOT NULL DEFAULT '작성 중',
    attendance_closed_at TEXT,
    attendance_closed_by TEXT,
    reopen_reason TEXT NOT NULL DEFAULT '',
    UNIQUE(run_id, session_number)
  );
  CREATE TABLE applications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES program_runs(id) ON DELETE SET NULL,
    applied_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '신청',
    queue_number INTEGER,
    status_reason TEXT NOT NULL DEFAULT '',
    status_updated_at TEXT NOT NULL DEFAULT '',
    assigned_at TEXT,
    UNIQUE(participant_id, program_id)
  );
  CREATE TABLE attendance (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT '미입력',
    note TEXT NOT NULL DEFAULT '',
    contacted_at TEXT,
    makeup_for_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    UNIQUE(application_id, session_id)
  );
  CREATE TABLE certificates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id TEXT NOT NULL REFERENCES participants(id),
    issued_at TEXT NOT NULL,
    session_count INTEGER NOT NULL
  );
  CREATE TABLE audit_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    created_at TEXT NOT NULL,
    actor TEXT NOT NULL,
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    before_json TEXT NOT NULL DEFAULT '',
    after_json TEXT NOT NULL DEFAULT '',
    summary TEXT NOT NULL DEFAULT '',
    ip_address TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE staff_users (
    id TEXT PRIMARY KEY,
    username TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    pin_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT '일반 담당자',
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    failed_attempts INTEGER NOT NULL DEFAULT 0,
    locked_until TEXT,
    last_login_at TEXT,
    pin_changed_at TEXT,
    must_change_pin INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE auth_sessions (
    token TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES staff_users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_seen_at TEXT,
    ip_address TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE assessment_catalog (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    min_score INTEGER NOT NULL DEFAULT 0,
    max_score INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL,
    version TEXT NOT NULL DEFAULT '1.0',
    description TEXT NOT NULL DEFAULT ''
  );
  CREATE TABLE program_assessments (
    program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    assessment_id TEXT NOT NULL REFERENCES assessment_catalog(id) ON DELETE CASCADE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(program_id, assessment_id)
  );
  CREATE TABLE assessment_scores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    assessment_id TEXT NOT NULL REFERENCES assessment_catalog(id) ON DELETE CASCADE,
    pre_score REAL,
    post_score REAL,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    pre_date TEXT,
    post_date TEXT,
    not_completed_reason TEXT NOT NULL DEFAULT '',
    assessor TEXT NOT NULL DEFAULT '',
    UNIQUE(application_id, assessment_id)
  );
  CREATE TABLE satisfaction_surveys (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL UNIQUE REFERENCES applications(id) ON DELETE CASCADE,
    score INTEGER,
    comment TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL,
    survey_version TEXT NOT NULL DEFAULT '1.0',
    anonymous INTEGER NOT NULL DEFAULT 0
  );
  CREATE TABLE schedule_events (
    id TEXT PRIMARY KEY,
    event_type TEXT NOT NULL DEFAULT '상담',
    color TEXT NOT NULL DEFAULT 'green',
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    event_date TEXT NOT NULL,
    all_day INTEGER NOT NULL DEFAULT 0,
    start_time TEXT NOT NULL DEFAULT '',
    end_time TEXT NOT NULL DEFAULT '',
    recurrence TEXT NOT NULL DEFAULT '1회',
    delivery_mode TEXT NOT NULL DEFAULT '대면',
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_participants_name ON participants(name);
  CREATE INDEX idx_runs_program ON program_runs(program_id, round_number);
  CREATE INDEX idx_sessions_run_date ON sessions(run_id, session_date);
  CREATE INDEX idx_applications_participant ON applications(participant_id);
  CREATE INDEX idx_applications_program ON applications(program_id);
  CREATE INDEX idx_applications_run ON applications(run_id);
  CREATE INDEX idx_applications_program_run ON applications(program_id, run_id);
  CREATE INDEX idx_applications_workflow ON applications(status, run_id, applied_at);
  CREATE INDEX idx_attendance_application ON attendance(application_id);
  CREATE INDEX idx_attendance_session ON attendance(session_id);
  CREATE INDEX idx_attendance_makeup_session ON attendance(makeup_for_session_id);
  CREATE INDEX idx_certificates_participant ON certificates(participant_id);
  CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
  CREATE INDEX idx_audit_entity ON audit_logs(entity_type, entity_id);
  CREATE INDEX idx_auth_user ON auth_sessions(user_id, expires_at);
  CREATE INDEX idx_scores_application ON assessment_scores(application_id);
  CREATE INDEX idx_schedule_events_date ON schedule_events(event_date, start_time);
  CREATE INDEX idx_schedule_events_participant ON schedule_events(participant_id);
  CREATE INDEX idx_sessions_attendance_status ON sessions(attendance_status, session_date);
  CREATE INDEX idx_users_locked ON staff_users(active, locked_until);
`;

const latestColumns:Record<string,string[]>={
  settings:['key','value'],
  participants:['id','name','gender','age','phone','member_status','note','created_at'],
  programs:['id','name','category','delivery_type','session_count','recurrence','location','manager','capacity','status','created_at'],
  program_runs:['id','program_id','round_number','label','start_date','status','closed_at','closed_by'],
  sessions:['id','run_id','session_number','session_date','session_time','location','attendance_status','attendance_closed_at','attendance_closed_by','reopen_reason'],
  applications:['id','participant_id','program_id','run_id','applied_at','status','queue_number','status_reason','status_updated_at','assigned_at'],
  attendance:['id','application_id','session_id','status','note','contacted_at','makeup_for_session_id'],
  certificates:['id','participant_id','issued_at','session_count'],
  audit_logs:['id','created_at','actor','action','entity_type','entity_id','before_json','after_json','summary','ip_address','reason'],
  staff_users:['id','username','display_name','pin_hash','role','active','created_at','failed_attempts','locked_until','last_login_at','pin_changed_at','must_change_pin'],
  auth_sessions:['token','user_id','expires_at','created_at','last_seen_at','ip_address'],
  assessment_catalog:['id','name','min_score','max_score','active','created_at','version','description'],
  program_assessments:['program_id','assessment_id','sort_order'],
  assessment_scores:['id','application_id','assessment_id','pre_score','post_score','note','updated_at','pre_date','post_date','not_completed_reason','assessor'],
  satisfaction_surveys:['id','application_id','score','comment','updated_at','survey_version','anonymous'],
  schedule_events:['id','event_type','color','participant_id','title','event_date','all_day','start_time','end_time','recurrence','delivery_mode','created_at'],
};

const integerColumns:Record<string,string[]>={participants:['age'],programs:['session_count','capacity'],program_runs:['round_number'],sessions:['session_number'],applications:['id','queue_number'],attendance:['id','application_id'],certificates:['id','session_count'],audit_logs:['id'],staff_users:['active','failed_attempts','must_change_pin'],assessment_catalog:['min_score','max_score','active'],program_assessments:['sort_order'],assessment_scores:['id','application_id'],satisfaction_surveys:['id','application_id','score','anonymous'],schedule_events:['all_day']};
const realColumns:Record<string,string[]>={assessment_scores:['pre_score','post_score']};
const primaryKeys:Record<string,string[]>={settings:['key'],participants:['id'],programs:['id'],program_runs:['id'],sessions:['id'],applications:['id'],attendance:['id'],certificates:['id'],audit_logs:['id'],staff_users:['id'],auth_sessions:['token'],assessment_catalog:['id'],program_assessments:['program_id','assessment_id'],assessment_scores:['id'],satisfaction_surveys:['id'],schedule_events:['id']};
const notNullColumns:Record<string,string[]>={
  settings:['value'],
  participants:['name','gender','age','phone','member_status','note','created_at'],
  programs:['name','category','delivery_type','session_count','recurrence','location','manager','capacity','status','created_at'],
  program_runs:['program_id','round_number','label','start_date','status'],
  sessions:['run_id','session_number','session_date','session_time','location','attendance_status','reopen_reason'],
  applications:['participant_id','program_id','applied_at','status','status_reason','status_updated_at'],
  attendance:['application_id','session_id','status','note'],
  certificates:['participant_id','issued_at','session_count'],
  audit_logs:['created_at','actor','action','entity_type','entity_id','before_json','after_json','summary','ip_address','reason'],
  staff_users:['username','display_name','pin_hash','role','active','created_at','failed_attempts','must_change_pin'],
  auth_sessions:['user_id','expires_at','created_at','ip_address'],
  assessment_catalog:['name','min_score','max_score','active','created_at','version','description'],
  program_assessments:['program_id','assessment_id','sort_order'],
  assessment_scores:['application_id','assessment_id','note','updated_at','not_completed_reason','assessor'],
  satisfaction_surveys:['application_id','comment','updated_at','survey_version','anonymous'],
  schedule_events:['event_type','color','participant_id','title','event_date','all_day','start_time','end_time','recurrence','delivery_mode','created_at'],
};
const columnDefaults:Record<string,Record<string,string>>={
  participants:{gender:"'미입력'",age:'0',phone:"''",member_status:"'비회원'",note:"''"},
  programs:{delivery_type:"'집단'",session_count:'1',recurrence:"'매주'",location:"''",manager:"''",capacity:'10',status:"'운영 중'"},
  program_runs:{status:"'모집 중'"},
  sessions:{attendance_status:"'작성 중'",reopen_reason:"''"},
  applications:{status:"'신청'",status_reason:"''",status_updated_at:"''"},
  attendance:{status:"'미입력'",note:"''"},
  audit_logs:{before_json:"''",after_json:"''",summary:"''",ip_address:"''",reason:"''"},
  staff_users:{role:"'일반 담당자'",active:'1',failed_attempts:'0',must_change_pin:'0'},
  auth_sessions:{ip_address:"''"},
  assessment_catalog:{min_score:'0',active:'1',version:"'1.0'",description:"''"},
  program_assessments:{sort_order:'0'},
  assessment_scores:{note:"''",not_completed_reason:"''",assessor:"''"},
  satisfaction_surveys:{comment:"''",survey_version:"'1.0'",anonymous:'0'},
  schedule_events:{event_type:"'상담'",color:"'green'",all_day:'0',start_time:"''",end_time:"''",recurrence:"'1회'",delivery_mode:"'대면'"},
};
const uniqueGroups:Record<string,string[][]>={program_runs:[['program_id','round_number']],sessions:[['run_id','session_number']],applications:[['participant_id','program_id']],attendance:[['application_id','session_id']],staff_users:[['username']],assessment_catalog:[['name']],assessment_scores:[['application_id','assessment_id']],satisfaction_surveys:[['application_id']]};

const legacyColumns:Record<string,string[]>={
  ...latestColumns,
  program_runs:['id','program_id','round_number','label','start_date','status'],
  sessions:['id','run_id','session_number','session_date','session_time','location'],
  applications:['id','participant_id','program_id','run_id','applied_at','status'],
  attendance:['id','application_id','session_id','status','note'],
  audit_logs:['id','created_at','actor','action','entity_type','entity_id','before_json','after_json','summary'],
  staff_users:['id','username','display_name','pin_hash','role','active','created_at'],
  auth_sessions:['token','user_id','expires_at','created_at'],
  assessment_catalog:['id','name','min_score','max_score','active','created_at'],
  assessment_scores:['id','application_id','assessment_id','pre_score','post_score','note','updated_at'],
  satisfaction_surveys:['id','application_id','score','comment','updated_at'],
};
const legacyApplicationsColumns:Record<string,string[]>={...legacyColumns,applications:['id','participant_id','run_id','applied_at','status']};

export const LATEST_SCHEMA_TABLES=Object.freeze(Object.keys(latestColumns));
export const LATEST_SCHEMA_COLUMNS=Object.freeze(Object.fromEntries(Object.entries(latestColumns).map(([table,columns])=>[table,Object.freeze([...columns])])));

export type SchemaColumnDefinition={name:string;type:string;pk:number;notNull:boolean;normalizedDefault:string|null};
function normalizeDefaultValue(value:string|null){
  // SQLite exposes no DEFAULT as null and DEFAULT NULL as the string "NULL", so they remain distinct.
  return value===null?null:value.trim();
}
function expectedColumnDetails(expected:Record<string,string[]>,legacyApplications=false){
  return Object.fromEntries(Object.entries(expected).map(([table,columnNames])=>[table,columnNames.map(name=>({
    name,
    type:(integerColumns[table]||[]).includes(name)?'INTEGER':(realColumns[table]||[]).includes(name)?'REAL':'TEXT',
    pk:(primaryKeys[table]||[]).indexOf(name)+1,
    notNull:(notNullColumns[table]||[]).includes(name)||(legacyApplications&&table==='applications'&&name==='run_id'),
    normalizedDefault:normalizeDefaultValue(Object.hasOwn(columnDefaults[table]||{},name)?columnDefaults[table][name]:null),
  }))])) as Record<string,SchemaColumnDefinition[]>;
}
export const LATEST_SCHEMA_COLUMN_MANIFEST=Object.freeze(Object.fromEntries(Object.entries(expectedColumnDetails(latestColumns)).map(([table,details])=>[table,Object.freeze(details.map(detail=>Object.freeze(detail)))])));

const latestIndexes:Record<string,string[]>={
  idx_participants_name:['name'],idx_runs_program:['program_id','round_number'],idx_sessions_run_date:['run_id','session_date'],
  idx_applications_participant:['participant_id'],idx_applications_program:['program_id'],idx_applications_run:['run_id'],idx_applications_program_run:['program_id','run_id'],idx_applications_workflow:['status','run_id','applied_at'],
  idx_attendance_application:['application_id'],idx_attendance_session:['session_id'],idx_attendance_makeup_session:['makeup_for_session_id'],idx_certificates_participant:['participant_id'],
  idx_audit_created:['created_at'],idx_audit_entity:['entity_type','entity_id'],idx_auth_user:['user_id','expires_at'],idx_scores_application:['application_id'],
  idx_schedule_events_date:['event_date','start_time'],idx_schedule_events_participant:['participant_id'],idx_sessions_attendance_status:['attendance_status','session_date'],idx_users_locked:['active','locked_until'],
};

const preVersionIndexes=Object.fromEntries(Object.entries(latestIndexes).filter(([name])=>!['idx_applications_program_run','idx_attendance_makeup_session','idx_certificates_participant'].includes(name)));
const legacyRuntimeIndexes=Object.fromEntries(Object.entries(preVersionIndexes).filter(([name])=>!['idx_applications_workflow','idx_sessions_attendance_status','idx_users_locked'].includes(name)));

type ForeignKeyRow={table:string;from:string;to:string;on_delete:string};
const criticalForeignKeys:Record<string,ForeignKeyRow[]>={
  program_runs:[{table:'programs',from:'program_id',to:'id',on_delete:'CASCADE'}],
  sessions:[{table:'program_runs',from:'run_id',to:'id',on_delete:'CASCADE'}],
  applications:[{table:'participants',from:'participant_id',to:'id',on_delete:'CASCADE'},{table:'programs',from:'program_id',to:'id',on_delete:'CASCADE'},{table:'program_runs',from:'run_id',to:'id',on_delete:'SET NULL'}],
  attendance:[{table:'applications',from:'application_id',to:'id',on_delete:'CASCADE'},{table:'sessions',from:'session_id',to:'id',on_delete:'CASCADE'},{table:'sessions',from:'makeup_for_session_id',to:'id',on_delete:'SET NULL'}],
  certificates:[{table:'participants',from:'participant_id',to:'id',on_delete:'NO ACTION'}],
  auth_sessions:[{table:'staff_users',from:'user_id',to:'id',on_delete:'CASCADE'}],
  program_assessments:[{table:'programs',from:'program_id',to:'id',on_delete:'CASCADE'},{table:'assessment_catalog',from:'assessment_id',to:'id',on_delete:'CASCADE'}],
  assessment_scores:[{table:'applications',from:'application_id',to:'id',on_delete:'CASCADE'},{table:'assessment_catalog',from:'assessment_id',to:'id',on_delete:'CASCADE'}],
  satisfaction_surveys:[{table:'applications',from:'application_id',to:'id',on_delete:'CASCADE'}],
  schedule_events:[{table:'participants',from:'participant_id',to:'id',on_delete:'CASCADE'}],
};

function quoted(identifier:string){return `"${identifier.replaceAll('"','""')}"`}
function userTables(db:DatabaseSync){return (db.prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as {name:string}[]).map(row=>row.name)}
type ColumnRow={name:string;type:string;notnull:number;dflt_value:string|null;pk:number};
function columnDetails(db:DatabaseSync,table:string):SchemaColumnDefinition[]{return (db.prepare(`PRAGMA table_info(${quoted(table)})`).all() as ColumnRow[]).map(row=>({name:row.name,type:row.type.trim().toUpperCase(),pk:row.pk,notNull:Boolean(row.notnull),normalizedDefault:normalizeDefaultValue(row.dflt_value)}))}
function columns(db:DatabaseSync,table:string){return columnDetails(db,table).map(row=>row.name)}
function indexes(db:DatabaseSync){
  const result:Record<string,string[]>={};
  for(const row of db.prepare("SELECT name,tbl_name FROM sqlite_schema WHERE type='index' AND sql IS NOT NULL ORDER BY name").all() as {name:string;tbl_name:string}[]){
    result[row.name]=(db.prepare(`PRAGMA index_info(${quoted(row.name)})`).all() as {name:string}[]).map(item=>item.name);
  }
  return result;
}
function foreignKeys(db:DatabaseSync,table:string){
  return (db.prepare(`PRAGMA foreign_key_list(${quoted(table)})`).all() as ForeignKeyRow[]).map(row=>({table:row.table,from:row.from,to:row.to,on_delete:row.on_delete})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}
function same(a:unknown,b:unknown){return JSON.stringify(a)===JSON.stringify(b)}

export function schemaFingerprint(db:DatabaseSync){
  const tables=userTables(db),columnMap=Object.fromEntries(tables.map(table=>[table,columnDetails(db,table)])),indexMap=indexes(db),uniqueMap=Object.fromEntries(tables.map(table=>[table,uniqueIndexGroups(db,table)])),fkMap=Object.fromEntries(tables.map(table=>[table,foreignKeys(db,table)]));
  return createHash('sha256').update(JSON.stringify({tables,columnMap,indexMap,uniqueMap,fkMap})).digest('hex');
}

function assertTablesAndColumns(db:DatabaseSync,expected:Record<string,string[]>,allowMissingSchedule=false,legacyApplications=false){
  const expectedTables=Object.keys(expected).filter(table=>!allowMissingSchedule||table!=='schedule_events').sort(),actualTables=userTables(db);
  if(!same(actualTables,expectedTables))throw new Error(`Schema table fingerprint mismatch. Expected ${expectedTables.join(', ')}.`);
  const expectedDetails=expectedColumnDetails(expected,legacyApplications);
  for(const [table,expectedColumns] of Object.entries(expected)){
    if(allowMissingSchedule&&table==='schedule_events')continue;
    const actual=columns(db,table);
    if(!same(actual,expectedColumns))throw new Error(`Schema column fingerprint mismatch: ${table}.`);
    for(const [index,detail] of columnDetails(db,table).entries()){
      const wanted=expectedDetails[table][index];
      if(detail.type!==wanted.type)throw new Error(`Schema column type mismatch: ${table}.${detail.name}.`);
      if(detail.pk!==wanted.pk)throw new Error(`Schema primary-key fingerprint mismatch: ${table}.${detail.name}.`);
      if(detail.notNull!==wanted.notNull)throw new Error(`Schema column nullability mismatch: ${table}.${detail.name}.`);
      if(detail.normalizedDefault!==wanted.normalizedDefault)throw new Error(`Schema column default mismatch: ${table}.${detail.name}.`);
    }
  }
}

function uniqueIndexGroups(db:DatabaseSync,table:string){
  const groups:string[][]=[];
  for(const row of db.prepare(`PRAGMA index_list(${quoted(table)})`).all() as {name:string;unique:number;origin:string}[]){
    if(row.unique===1&&row.origin==='u')groups.push((db.prepare(`PRAGMA index_info(${quoted(row.name)})`).all() as {name:string}[]).map(item=>item.name));
  }
  return groups.sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function assertUniqueConstraints(db:DatabaseSync,legacyApplications=false){
  for(const table of Object.keys(latestColumns)){
    const expected=legacyApplications&&table==='applications'?[['participant_id','run_id']]:(uniqueGroups[table]||[]);
    if(!same(uniqueIndexGroups(db,table),[...expected].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))))throw new Error(`Schema unique-constraint fingerprint mismatch: ${table}.`);
  }
}

function assertIndexes(db:DatabaseSync,expected:Record<string,string[]>,exact:boolean){
  const actual=indexes(db);
  for(const [name,expectedColumns] of Object.entries(expected))if(!same(actual[name],expectedColumns))throw new Error(`Schema index fingerprint mismatch: ${name}.`);
  if(exact){
    const expectedNames=Object.keys(expected).sort(),actualNames=Object.keys(actual).sort();
    if(!same(actualNames,expectedNames))throw new Error('Schema index fingerprint contains unexpected or missing indexes.');
  }
}

function assertForeignKeys(db:DatabaseSync,includeMakeup:boolean,allowMissingSchedule=false){
  for(const [table,expected] of Object.entries(criticalForeignKeys)){
    if(allowMissingSchedule&&table==='schedule_events')continue;
    const wanted=table==='attendance'&&!includeMakeup?expected.filter(item=>item.from!=='makeup_for_session_id'):expected;
    if(!same(foreignKeys(db,table),[...wanted].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))))throw new Error(`Schema foreign-key fingerprint mismatch: ${table}.`);
  }
}

export function validateForeignKeyIntegrity(db:DatabaseSync){
  const violations=db.prepare('PRAGMA foreign_key_check').all();
  if(violations.length)throw new Error(`Foreign-key integrity check failed (${violations.length} violation(s)).`);
}

export function validateLatestSchema(db:DatabaseSync,{checkVersion=true}:{checkVersion?:boolean}={}){
  if(checkVersion){
    const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
    if(version!==CURRENT_SCHEMA_VERSION)throw new Error(`Schema version mismatch: expected ${CURRENT_SCHEMA_VERSION}, found ${version}.`);
  }
  assertTablesAndColumns(db,latestColumns);
  assertIndexes(db,latestIndexes,true);
  assertUniqueConstraints(db);
  assertForeignKeys(db,true);
  validateForeignKeyIntegrity(db);
  return {version:CURRENT_SCHEMA_VERSION,fingerprint:schemaFingerprint(db)};
}

export type LegacyV0Profile='latest-v0'|'legacy-runtime-v0'|'legacy-runtime-without-schedule-v0'|'legacy-applications-v0'|'legacy-applications-without-schedule-v0';
export function classifyKnownV0Schema(db:DatabaseSync):LegacyV0Profile{
  const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
  if(version!==0)throw new Error(`migrate-schema requires schema version 0; found ${version}.`);
  try {
    assertTablesAndColumns(db,latestColumns);
    assertIndexes(db,preVersionIndexes,true);
    assertUniqueConstraints(db);
    assertForeignKeys(db,false);
    return 'latest-v0';
  } catch {}
  for(const allowMissingSchedule of [false,true]){
    try {
      assertTablesAndColumns(db,legacyColumns,allowMissingSchedule);
      const expectedIndexes=Object.fromEntries(Object.entries(legacyRuntimeIndexes).filter(([name])=>!allowMissingSchedule||!name.startsWith('idx_schedule_events_')));
      assertIndexes(db,expectedIndexes,true);
      assertUniqueConstraints(db);
      assertForeignKeys(db,false,allowMissingSchedule);
      return allowMissingSchedule?'legacy-runtime-without-schedule-v0':'legacy-runtime-v0';
    } catch {}
  }
  for(const allowMissingSchedule of [false,true]){
    try {
      assertTablesAndColumns(db,legacyApplicationsColumns,allowMissingSchedule,true);
      const expectedIndexes=Object.fromEntries(Object.entries(legacyRuntimeIndexes).filter(([name])=>!['idx_applications_program'].includes(name)&&(!allowMissingSchedule||!name.startsWith('idx_schedule_events_'))));
      assertIndexes(db,expectedIndexes,true);
      assertUniqueConstraints(db,true);
      const applicationFks=foreignKeys(db,'applications');
      const applicationTargets=applicationFks.map(item=>({table:item.table,from:item.from,to:item.to})).sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      const expectedTargets=[{table:'participants',from:'participant_id',to:'id'},{table:'program_runs',from:'run_id',to:'id'}].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if(!same(applicationTargets,expectedTargets))throw new Error('Legacy applications foreign keys do not match.');
      for(const table of Object.keys(criticalForeignKeys).filter(table=>table!=='applications'&&(!allowMissingSchedule||table!=='schedule_events'))){
        const expected=criticalForeignKeys[table].filter(item=>item.from!=='makeup_for_session_id');
        if(!same(foreignKeys(db,table),[...expected].sort((a,b)=>JSON.stringify(a).localeCompare(JSON.stringify(b)))))throw new Error(`Legacy foreign-key mismatch: ${table}.`);
      }
      return allowMissingSchedule?'legacy-applications-without-schedule-v0':'legacy-applications-v0';
    } catch {}
  }
  throw new Error('Unknown or partially migrated schema version 0; automatic repair is refused.');
}

export function createLatestSchema(db:DatabaseSync){
  db.exec(LATEST_SCHEMA_SQL);
  db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
  return validateLatestSchema(db);
}

function ensureColumn(db:DatabaseSync,table:string,column:string,definition:string){
  if(!columns(db,table).includes(column))db.exec(`ALTER TABLE ${quoted(table)} ADD COLUMN ${quoted(column)} ${definition}`);
}

function addLegacyOperationalColumns(db:DatabaseSync){
  ensureColumn(db,'program_runs','closed_at','TEXT');ensureColumn(db,'program_runs','closed_by','TEXT');
  ensureColumn(db,'sessions','attendance_status',"TEXT NOT NULL DEFAULT '작성 중'");ensureColumn(db,'sessions','attendance_closed_at','TEXT');ensureColumn(db,'sessions','attendance_closed_by','TEXT');ensureColumn(db,'sessions','reopen_reason',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'applications','queue_number','INTEGER');ensureColumn(db,'applications','status_reason',"TEXT NOT NULL DEFAULT ''");ensureColumn(db,'applications','status_updated_at',"TEXT NOT NULL DEFAULT ''");ensureColumn(db,'applications','assigned_at','TEXT');
  ensureColumn(db,'attendance','contacted_at','TEXT');ensureColumn(db,'attendance','makeup_for_session_id','TEXT');
  ensureColumn(db,'assessment_catalog','version',"TEXT NOT NULL DEFAULT '1.0'");ensureColumn(db,'assessment_catalog','description',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'assessment_scores','pre_date','TEXT');ensureColumn(db,'assessment_scores','post_date','TEXT');ensureColumn(db,'assessment_scores','not_completed_reason',"TEXT NOT NULL DEFAULT ''");ensureColumn(db,'assessment_scores','assessor',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'satisfaction_surveys','survey_version',"TEXT NOT NULL DEFAULT '1.0'");ensureColumn(db,'satisfaction_surveys','anonymous','INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db,'staff_users','failed_attempts','INTEGER NOT NULL DEFAULT 0');ensureColumn(db,'staff_users','locked_until','TEXT');ensureColumn(db,'staff_users','last_login_at','TEXT');ensureColumn(db,'staff_users','pin_changed_at','TEXT');ensureColumn(db,'staff_users','must_change_pin','INTEGER NOT NULL DEFAULT 0');
  ensureColumn(db,'auth_sessions','last_seen_at','TEXT');ensureColumn(db,'auth_sessions','ip_address',"TEXT NOT NULL DEFAULT ''");
  ensureColumn(db,'audit_logs','ip_address',"TEXT NOT NULL DEFAULT ''");ensureColumn(db,'audit_logs','reason',"TEXT NOT NULL DEFAULT ''");
  const pending=db.prepare('SELECT id,program_id FROM applications WHERE queue_number IS NULL ORDER BY program_id,applied_at,id').all() as {id:number;program_id:string}[];
  const counters=new Map<string,number>();
  for(const row of db.prepare('SELECT program_id,COALESCE(MAX(queue_number),0) AS max_queue FROM applications WHERE queue_number IS NOT NULL GROUP BY program_id').all() as {program_id:string;max_queue:number}[])counters.set(row.program_id,row.max_queue);
  const update=db.prepare("UPDATE applications SET queue_number=?,status_updated_at=CASE WHEN status_updated_at='' THEN applied_at ELSE status_updated_at END WHERE id=?");
  for(const row of pending){const next=(counters.get(row.program_id)||0)+1;counters.set(row.program_id,next);update.run(next,row.id)}
  db.exec("UPDATE applications SET status='참가대기' WHERE status IN ('승인','대기')");
}

function rebuildLegacyApplications(db:DatabaseSync){
  db.exec(`CREATE TABLE applications_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,
    program_id TEXT NOT NULL REFERENCES programs(id) ON DELETE CASCADE,
    run_id TEXT REFERENCES program_runs(id) ON DELETE SET NULL,
    applied_at TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT '신청',
    UNIQUE(participant_id, program_id)
  )`);
  db.exec(`INSERT INTO applications_new (id,participant_id,program_id,run_id,applied_at,status)
    SELECT a.id,a.participant_id,r.program_id,a.run_id,a.applied_at,CASE WHEN a.status IN ('승인','대기') THEN '참가대기' ELSE a.status END
    FROM applications a JOIN program_runs r ON r.id=a.run_id`);
  const sourceCount=(db.prepare('SELECT COUNT(*) AS count FROM applications').get() as {count:number}).count;
  const migratedCount=(db.prepare('SELECT COUNT(*) AS count FROM applications_new').get() as {count:number}).count;
  if(sourceCount!==migratedCount)throw new Error('Legacy applications contain rows without a canonical program run; migration is refused.');
  db.exec('DROP TABLE applications');
  db.exec('ALTER TABLE applications_new RENAME TO applications');
}

function createScheduleEvents(db:DatabaseSync){
  db.exec(`CREATE TABLE schedule_events (id TEXT PRIMARY KEY,event_type TEXT NOT NULL DEFAULT '상담',color TEXT NOT NULL DEFAULT 'green',participant_id TEXT NOT NULL REFERENCES participants(id) ON DELETE CASCADE,title TEXT NOT NULL,event_date TEXT NOT NULL,all_day INTEGER NOT NULL DEFAULT 0,start_time TEXT NOT NULL DEFAULT '',end_time TEXT NOT NULL DEFAULT '',recurrence TEXT NOT NULL DEFAULT '1회',delivery_mode TEXT NOT NULL DEFAULT '대면',created_at TEXT NOT NULL)`);
}

function rebuildAttendance(db:DatabaseSync){
  db.exec(`CREATE TABLE attendance_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    application_id INTEGER NOT NULL REFERENCES applications(id) ON DELETE CASCADE,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    status TEXT NOT NULL DEFAULT '미입력',
    note TEXT NOT NULL DEFAULT '',
    contacted_at TEXT,
    makeup_for_session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
    UNIQUE(application_id, session_id)
  )`);
  db.exec('INSERT INTO attendance_new (id,application_id,session_id,status,note,contacted_at,makeup_for_session_id) SELECT id,application_id,session_id,status,note,contacted_at,NULLIF(makeup_for_session_id,\'\') FROM attendance');
  db.exec('DROP TABLE attendance');
  db.exec('ALTER TABLE attendance_new RENAME TO attendance');
}

function createLatestIndexes(db:DatabaseSync){
  for(const [name,indexColumns] of Object.entries(latestIndexes)){
    const table=name.startsWith('idx_participants')?'participants':name.startsWith('idx_runs')?'program_runs':name.startsWith('idx_sessions')?'sessions':name.startsWith('idx_applications')?'applications':name.startsWith('idx_attendance')?'attendance':name.startsWith('idx_certificates')?'certificates':name.startsWith('idx_audit')?'audit_logs':name.startsWith('idx_auth')?'auth_sessions':name.startsWith('idx_scores')?'assessment_scores':name.startsWith('idx_schedule')?'schedule_events':'staff_users';
    db.exec(`CREATE INDEX IF NOT EXISTS ${quoted(name)} ON ${quoted(table)} (${indexColumns.map(quoted).join(', ')})`);
  }
}

export function migrateKnownV0Schema(db:DatabaseSync){
  const profile=classifyKnownV0Schema(db);
  const orphanCount=(db.prepare("SELECT COUNT(*) AS count FROM attendance a LEFT JOIN sessions s ON s.id=a.makeup_for_session_id WHERE NULLIF(a.makeup_for_session_id,'') IS NOT NULL AND s.id IS NULL").get() as {count:number}).count;
  if(orphanCount)throw new Error(`Attendance makeup references contain ${orphanCount} orphan value(s); migration is refused.`);
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      if(profile.includes('without-schedule'))createScheduleEvents(db);
      if(profile.startsWith('legacy-applications'))rebuildLegacyApplications(db);
      if(profile!=='latest-v0')addLegacyOperationalColumns(db);
      rebuildAttendance(db);
      createLatestIndexes(db);
      validateLatestSchema(db,{checkVersion:false});
      db.exec(`PRAGMA user_version = ${CURRENT_SCHEMA_VERSION}`);
      const version=Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version);
      if(version!==CURRENT_SCHEMA_VERSION)throw new Error('Schema version update did not persist inside the migration transaction.');
      db.exec('COMMIT');
    } catch(error){try{db.exec('ROLLBACK')}catch{}throw error}
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
    const enabled=Number((db.prepare('PRAGMA foreign_keys').get() as {foreign_keys:number}).foreign_keys);
    if(enabled!==1)throw new Error('SQLite foreign_keys could not be restored after schema migration.');
  }
  return {profile,...validateLatestSchema(db)};
}
