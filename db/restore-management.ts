import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { copyFileExclusive, validateProductionMetadata, verifyBackupArtifactDetailed, type BackupArtifact, type VerifiedBackupArtifactIdentity } from './backup-management.ts';
import { CURRENT_SCHEMA_VERSION, createLatestSchema, validateForeignKeyIntegrity, validateLatestSchema } from './schema-management.ts';

type RestoreTable={name:string;columns:readonly string[]};

export const RESTORE_TABLE_CONTRACT:readonly RestoreTable[]=Object.freeze([
  {name:'settings',columns:['key','value']},
  {name:'participants',columns:['id','name','gender','age','phone','member_status','note','created_at']},
  {name:'programs',columns:['id','name','category','delivery_type','session_count','recurrence','location','manager','capacity','status','created_at']},
  {name:'program_runs',columns:['id','program_id','round_number','label','start_date','status','closed_at','closed_by']},
  {name:'sessions',columns:['id','run_id','session_number','session_date','session_time','location','attendance_status','attendance_closed_at','attendance_closed_by','reopen_reason']},
  {name:'applications',columns:['id','participant_id','program_id','run_id','applied_at','status','queue_number','status_reason','status_updated_at','assigned_at']},
  {name:'certificates',columns:['id','participant_id','issued_at','session_count']},
  {name:'assessment_catalog',columns:['id','name','min_score','max_score','active','created_at','version','description']},
  {name:'program_assessments',columns:['program_id','assessment_id','sort_order']},
  {name:'assessment_scores',columns:['id','application_id','assessment_id','pre_score','post_score','note','updated_at','pre_date','post_date','not_completed_reason','assessor']},
  {name:'satisfaction_surveys',columns:['id','application_id','score','comment','updated_at','survey_version','anonymous']},
  {name:'attendance',columns:['id','application_id','session_id','status','note','contacted_at','makeup_for_session_id']},
  {name:'schedule_events',columns:['id','event_type','color','participant_id','title','event_date','all_day','start_time','end_time','recurrence','delivery_mode','created_at']},
].map(table=>Object.freeze({...table,columns:Object.freeze([...table.columns])})));

const DELETE_ORDER=[
  'schedule_events','satisfaction_surveys','assessment_scores','attendance','program_assessments','certificates',
  'applications','sessions','program_runs','assessment_catalog','programs','participants','settings',
] as const;
const RESTORE_PURPOSES=new Set(['manual','restore_safety']);

function quoted(identifier:string){return `"${identifier.replaceAll('"','""')}"`;}
function count(db:DatabaseSync,sql:string){return Number((db.prepare(sql).get() as {count:number}).count);}
function fileSha256(filePath:string){return createHash('sha256').update(readFileSync(filePath)).digest('hex');}

export function validateRestoreBusinessConsistency(db:DatabaseSync){
  const applicationMismatch=count(db,`SELECT COUNT(*) AS count FROM applications a JOIN program_runs r ON r.id=a.run_id WHERE a.run_id IS NOT NULL AND a.program_id<>r.program_id`);
  if(applicationMismatch)throw new Error('Restore application/run consistency validation failed.');
  const attendanceMismatch=count(db,`SELECT COUNT(*) AS count FROM attendance at JOIN applications a ON a.id=at.application_id JOIN sessions s ON s.id=at.session_id JOIN program_runs r ON r.id=s.run_id WHERE a.run_id IS NULL OR a.run_id<>s.run_id OR a.program_id<>r.program_id`);
  if(attendanceMismatch)throw new Error('Restore attendance scope consistency validation failed.');
  const makeupMismatch=count(db,`SELECT COUNT(*) AS count FROM attendance at JOIN sessions s ON s.id=at.session_id JOIN sessions m ON m.id=at.makeup_for_session_id WHERE at.makeup_for_session_id IS NOT NULL AND s.run_id<>m.run_id`);
  if(makeupMismatch)throw new Error('Restore attendance makeup consistency validation failed.');
}

export function validateRestoreState(db:DatabaseSync){
  const schema=validateLatestSchema(db);
  validateProductionMetadata(db);
  validateRestoreBusinessConsistency(db);
  validateForeignKeyIntegrity(db);
  return schema;
}

export type RestoreArtifactIdentity=Pick<VerifiedBackupArtifactIdentity,'basename'|'canonicalBackupPath'|'canonicalManifestPath'|'sha256'|'manifestSha256'|'byteSize'|'purpose'|'schemaVersion'|'schemaFingerprint'|'manifestVersion'>;
export type OpenRestoreCandidate={artifact:BackupArtifact;identity:RestoreArtifactIdentity;stagedSourcePath:string;stagingDirectory:string;db:DatabaseSync};

function integrityCheck(db:DatabaseSync){
  const rows=db.prepare('PRAGMA integrity_check').all() as {integrity_check:string}[];
  if(rows.length!==1||rows[0].integrity_check!=='ok')throw new Error('Restore source SQLite integrity_check failed.');
}
function removeStagedSource(directory:string){try {rmSync(directory,{recursive:true,force:true});}catch{console.error('[restore] staged_source_cleanup_failed');}}
function validateStagedSource(candidate:OpenRestoreCandidate){
  if(statSync(candidate.stagedSourcePath).size!==candidate.identity.byteSize||fileSha256(candidate.stagedSourcePath)!==candidate.identity.sha256)throw new Error('Restore staged source identity mismatch.');
  candidate.db.exec('PRAGMA query_only = ON');
  candidate.db.exec('PRAGMA foreign_keys = ON');
  integrityCheck(candidate.db);
  const schema=validateRestoreState(candidate.db);
  if(schema.version!==candidate.identity.schemaVersion||schema.fingerprint!==candidate.identity.schemaFingerprint)throw new Error('Restore staged source schema identity mismatch.');
}

export function openRestoreCandidate(sourceDatabasePath:string,backupDirectory:string,basename:string):OpenRestoreCandidate {
  const verified=verifyBackupArtifactDetailed(sourceDatabasePath,backupDirectory,basename),identity=verified.identity;
  if(!RESTORE_PURPOSES.has(verified.artifact.purpose))throw new Error('Backup purpose is not restore-compatible.');
  const stagingDirectory=mkdtempSync(path.join(tmpdir(),'onmaeum-restore-source-')),stagedSourcePath=path.join(stagingDirectory,'candidate.sqlite');
  let db:DatabaseSync|undefined;
  try {
    copyFileExclusive(identity.canonicalBackupPath,stagedSourcePath);
    if(fileSha256(identity.canonicalManifestPath)!==identity.manifestSha256)throw new Error('Restore candidate manifest changed during staging.');
    db=new DatabaseSync(stagedSourcePath,{readOnly:true});
    const candidate={artifact:verified.artifact,identity,stagedSourcePath,stagingDirectory,db};
    validateStagedSource(candidate);
    return candidate;
  } catch(error) {
    try {db?.close();}catch{console.error('[restore] staged_source_close_failed');}
    removeStagedSource(stagingDirectory);
    throw error;
  }
}

export function reverifyRestoreCandidate(candidate:OpenRestoreCandidate){
  validateStagedSource(candidate);
  return candidate.artifact;
}

export function closeRestoreCandidate(candidate:OpenRestoreCandidate){
  try {candidate.db.close();}catch{console.error('[restore] staged_source_close_failed');}
  removeStagedSource(candidate.stagingDirectory);
}

export class RestoreRollbackFailure extends Error {
  readonly originalError:unknown;
  readonly rollbackError:unknown;
  constructor(originalError:unknown,rollbackError:unknown){super('Restore rollback failed; database restart is required.',{cause:originalError});this.name='RestoreRollbackFailure';this.originalError=originalError;this.rollbackError=rollbackError;}
}

export type RestoreSummary={restoredTableCount:number;rowCounts:Record<string,number>;foreignKeys:'ok';schemaVersion:number};

export function restoreBusinessData({targetDb,sourceDb,writeAudit,invalidateSessions=true,onRollbackFailure}:{targetDb:DatabaseSync;sourceDb:DatabaseSync;writeAudit?:(summary:RestoreSummary)=>void;invalidateSessions?:boolean;onRollbackFailure?:(error:RestoreRollbackFailure)=>void}):RestoreSummary {
  let transactionOpen=false;
  try {
    targetDb.exec('BEGIN IMMEDIATE');transactionOpen=true;
    for(const table of DELETE_ORDER)targetDb.exec(`DELETE FROM ${quoted(table)}`);
    const rowCounts:Record<string,number>={};
    for(const table of RESTORE_TABLE_CONTRACT){
      const columns=table.columns.map(quoted),rows=sourceDb.prepare(`SELECT ${columns.join(',')} FROM ${quoted(table.name)}`).all() as Record<string,SQLInputValue>[];
      rowCounts[table.name]=rows.length;
      if(!rows.length)continue;
      const insert=targetDb.prepare(`INSERT INTO ${quoted(table.name)} (${columns.join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
      for(const row of rows)insert.run(...table.columns.map(column=>row[column]));
    }
    const schema=validateRestoreState(targetDb);
    const summary:RestoreSummary={restoredTableCount:RESTORE_TABLE_CONTRACT.length,rowCounts,foreignKeys:'ok',schemaVersion:schema.version};
    writeAudit?.(summary);
    if(invalidateSessions)targetDb.exec('DELETE FROM auth_sessions');
    targetDb.exec('COMMIT');transactionOpen=false;
    return summary;
  } catch(error) {
    if(transactionOpen){
      try {targetDb.exec('ROLLBACK');}
      catch(rollbackError){const fatal=new RestoreRollbackFailure(error,rollbackError);onRollbackFailure?.(fatal);throw fatal;}
    }
    throw error;
  }
}

function initializeDrillControlPlane(db:DatabaseSync){
  createLatestSchema(db);
  db.exec('PRAGMA foreign_keys = ON');
  db.prepare("INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at) VALUES ('USR-RESTORE-DRILL','restore-drill','복원 훈련 관리자','drill-only','관리자',1,'2000-01-01')").run();
}

export function runRestoreDrill(sourceDatabasePath:string,backupDirectory:string,basename:string){
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-restore-drill-')),targetPath=path.join(directory,'drill.sqlite');
  let candidate:OpenRestoreCandidate|undefined,target:DatabaseSync|undefined,problem:unknown,result:{candidateBasename:string;purpose:string;compatible:true;restoredTableCounts:Record<string,number>;foreignKeys:'ok';schemaVersion:number;success:true}|undefined;
  try {
    candidate=openRestoreCandidate(sourceDatabasePath,backupDirectory,basename);
    target=new DatabaseSync(targetPath);
    target.exec('PRAGMA foreign_keys = ON; PRAGMA synchronous = FULL');
    initializeDrillControlPlane(target);
    reverifyRestoreCandidate(candidate);
    const restored=restoreBusinessData({targetDb:target,sourceDb:candidate.db});
    const validated=validateRestoreState(target);
    result={candidateBasename:candidate.artifact.basename,purpose:candidate.artifact.purpose,compatible:true,restoredTableCounts:restored.rowCounts,foreignKeys:'ok',schemaVersion:validated.version,success:true};
  } catch(error) {problem=error;}
  finally {
    try {target?.close();}catch{console.error('[restore-drill] target_close_failed');}
    if(candidate)closeRestoreCandidate(candidate);
    try {rmSync(directory,{recursive:true,force:true});}catch{console.error('[restore-drill] cleanup_failed');}
  }
  if(problem)throw problem;
  if(!result)throw new Error('Restore drill did not produce a result.');
  return result;
}

export function currentRestoreSchemaVersion(){return CURRENT_SCHEMA_VERSION;}
