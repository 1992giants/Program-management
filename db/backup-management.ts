import { backup, DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import path from 'node:path';
import { CURRENT_SCHEMA_VERSION, classifyKnownV0Schema, schemaFingerprint, validateForeignKeyIntegrity, validateLatestSchema } from './schema-management.ts';

export type BackupPurpose='manual'|'migration_safety'|'restore_safety';
export type BackupArtifact={basename:string;purpose:BackupPurpose;created_at:string;size:number;schema_version:number;verified:true};
export type BackupRetentionWarning={code:'retention_cleanup_failed';basename?:string};
export type VerifiedBackupArtifactIdentity={basename:string;canonicalBackupPath:string;canonicalManifestPath:string;sha256:string;manifestSha256:string;byteSize:number;purpose:BackupPurpose;schemaVersion:number;schemaFingerprint:string;manifestVersion:1};
export type VerifiedBackupArtifact={artifact:BackupArtifact;identity:VerifiedBackupArtifactIdentity};
type BackupManifest={manifest_version:1;backup_basename:string;purpose:BackupPurpose;created_at:string;byte_size:number;sha256:string;schema_version:number;schema_fingerprint:string};
type ArtifactIdentity={timestamp:number;nonce:string};

const APPLICATION_ID='onmaeum-program-care';
const PURPOSES=new Set<BackupPurpose>(['manual','migration_safety','restore_safety']);

function fail(message:string):never { throw new Error(message); }
function sourceBase(sourceDatabasePath:string){return path.basename(sourceDatabasePath,path.extname(sourceDatabasePath));}
function formatBasename(sourceDatabasePath:string,purpose:BackupPurpose,{timestamp,nonce}:ArtifactIdentity){return `${sourceBase(sourceDatabasePath)}-backup-${purpose}-${timestamp}-${nonce}.sqlite`;}
function parseBasename(sourceDatabasePath:string,basename:string):{purpose:BackupPurpose}|null {
  const pattern=new RegExp(`^${sourceBase(sourceDatabasePath).replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}-backup-(manual|migration_safety|restore_safety)-\\d{13,}-[0-9a-f]{32}\\.sqlite$`);
  const match=pattern.exec(basename);
  return match&&PURPOSES.has(match[1] as BackupPurpose)?{purpose:match[1] as BackupPurpose}:null;
}
function contained(root:string,target:string){const relative=path.relative(root,target);return relative!==''&&!relative.startsWith(`..${path.sep}`)&&relative!=='..'&&!path.isAbsolute(relative);}
function canonicalRoot(backupDirectory:string,{create=false}:{create?:boolean}={}){
  if(create)mkdirSync(backupDirectory,{recursive:true});
  if(!existsSync(backupDirectory))fail('백업 폴더가 존재하지 않습니다.');
  const root=realpathSync(backupDirectory);
  if(!lstatSync(root).isDirectory())fail('백업 경로가 디렉터리가 아닙니다.');
  return root;
}
function regularFileInside(root:string,filename:string){
  if(path.basename(filename)!==filename)fail('백업 파일명은 basename만 허용됩니다.');
  const candidate=path.join(root,filename);
  if(!contained(root,candidate)||!existsSync(candidate))fail('선택한 백업 파일이 없습니다.');
  const entry=lstatSync(candidate);
  if(!entry.isFile()||entry.isSymbolicLink())fail('일반 백업 파일만 허용됩니다.');
  const actual=realpathSync(candidate);
  if(!contained(root,actual)||!lstatSync(actual).isFile())fail('백업 파일이 설정된 백업 폴더 밖을 가리킵니다.');
  return actual;
}
function sha256(filePath:string){return createHash('sha256').update(readFileSync(filePath)).digest('hex');}
function validIsoTimestamp(value:string){const parsed=Date.parse(value);return Number.isFinite(parsed)&&new Date(parsed).toISOString()===value;}
function bestEffortRemove(filePath:string){try {rmSync(filePath,{force:true});}catch(error){console.error('[backup] cleanup failed',error);}}
function publishExclusive(source:string,destination:string){
  let sourceHandle:number|undefined,destinationHandle:number|undefined,created=false,problem:unknown;
  try {
    sourceHandle=openSync(source,'r');destinationHandle=openSync(destination,'wx');created=true;
    const buffer=Buffer.allocUnsafe(1024*1024);let bytesRead=0;
    while((bytesRead=readSync(sourceHandle,buffer,0,buffer.length,null))>0){let offset=0;while(offset<bytesRead){const written=writeSync(destinationHandle,buffer,offset,bytesRead-offset);if(written<=0)fail('백업 artifact publish write가 완료되지 않았습니다.');offset+=written;}}
    fsyncSync(destinationHandle);
  } catch(error) {problem=error;}
  finally {if(sourceHandle!==undefined)try{closeSync(sourceHandle)}catch{}if(destinationHandle!==undefined)try{closeSync(destinationHandle)}catch{}}
  if(problem){if(created)bestEffortRemove(destination);throw problem;}
}
function integrityCheck(db:DatabaseSync){
  const rows=db.prepare('PRAGMA integrity_check').all() as {integrity_check:string}[];
  if(rows.length!==1||rows[0].integrity_check!=='ok')fail('SQLite integrity_check failed.');
}
function setting(db:DatabaseSync,key:string){return (db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value;}
export function validateProductionMetadata(db:DatabaseSync){
  const expectedEnvironment=process.env.NODE_ENV==='production'?'production':process.env.NODE_ENV==='test'?'test':'development';
  if(setting(db,'application_id')!==APPLICATION_ID||setting(db,'database_environment')!==expectedEnvironment)fail('백업이 현재 환경의 Onmaeum DB marker와 일치하지 않습니다.');
  if(!setting(db,'center_name')?.trim()||!setting(db,'manager_name')?.trim())fail('백업에 필요한 production baseline 설정이 없습니다.');
  const administrators=(db.prepare("SELECT COUNT(*) AS count FROM staff_users WHERE role='관리자' AND active=1").get() as {count:number}).count;
  if(administrators<1)fail('백업에 활성 production 관리자가 없습니다.');
  const assessments=(db.prepare("SELECT COUNT(*) AS count FROM assessment_catalog WHERE id IN ('ASM-PHQ9','ASM-GAD7','ASM-PSS10')").get() as {count:number}).count;
  if(assessments!==3)fail('백업에 필요한 baseline assessment catalog가 없습니다.');
  if(db.prepare('SELECT id FROM staff_users WHERE id=?').get('USR-ADMIN')&&setting(db,'usr_admin_migration_completed')!=='1')fail('백업에 검토되지 않은 USR-ADMIN 계정이 있습니다.');
}
function validateCandidate(db:DatabaseSync,purpose:BackupPurpose,expected?:{version:number;fingerprint:string}){
  db.exec('PRAGMA query_only = ON');
  db.exec('PRAGMA foreign_keys = ON');
  integrityCheck(db);
  validateForeignKeyIntegrity(db);
  if(purpose==='migration_safety'){
    if(!expected||Number((db.prepare('PRAGMA user_version').get() as {user_version:number}).user_version)!==expected.version)fail('Schema migration safety backup version mismatch.');
    classifyKnownV0Schema(db);
    validateProductionMetadata(db);
    if(schemaFingerprint(db)!==expected.fingerprint)fail('Schema migration safety backup fingerprint mismatch.');
    return {schemaVersion:expected.version,fingerprint:expected.fingerprint};
  }
  const schema=validateLatestSchema(db);
  validateProductionMetadata(db);
  return {schemaVersion:schema.version,fingerprint:schema.fingerprint};
}
function manifestPath(basename:string){return `${basename}.manifest.json`;}
function readManifest(root:string,sourceDatabasePath:string,basename:string){
  const parsed=parseBasename(sourceDatabasePath,basename);
  if(!parsed)fail('허용되지 않은 백업 파일명입니다.');
  const databasePath=regularFileInside(root,basename),sidecar=regularFileInside(root,manifestPath(basename));
  const manifestBytes=readFileSync(sidecar);let manifest:BackupManifest;
  try { manifest=JSON.parse(manifestBytes.toString('utf8')) as BackupManifest; } catch { fail('백업 manifest를 읽을 수 없습니다.'); }
  const expectedVersion=parsed.purpose==='migration_safety'?0:CURRENT_SCHEMA_VERSION;
  if(!manifest||manifest.manifest_version!==1||manifest.backup_basename!==basename||manifest.purpose!==parsed.purpose||!PURPOSES.has(manifest.purpose)||typeof manifest.created_at!=='string'||!validIsoTimestamp(manifest.created_at)||!Number.isSafeInteger(manifest.byte_size)||manifest.byte_size<=0||typeof manifest.sha256!=='string'||!/^[0-9a-f]{64}$/.test(manifest.sha256)||manifest.schema_version!==expectedVersion||typeof manifest.schema_fingerprint!=='string'||!/^[0-9a-f]{64}$/.test(manifest.schema_fingerprint))fail('백업 manifest 형식이 올바르지 않습니다.');
  if(statSync(databasePath).size!==manifest.byte_size)fail('백업 파일 크기가 manifest와 일치하지 않습니다.');
  return {databasePath,manifestPath:sidecar,manifest,manifestSha256:createHash('sha256').update(manifestBytes).digest('hex')};
}

export function resolveBackupBasename(sourceDatabasePath:string,backupDirectory:string,basename:string){
  const root=canonicalRoot(backupDirectory);
  return readManifest(root,sourceDatabasePath,basename).databasePath;
}

export function copyFileExclusive(source:string,destination:string){publishExclusive(source,destination);}

export async function createVerifiedBackup(source:DatabaseSync,{sourceDatabasePath,backupDirectory,purpose,expectedSource,artifactIdentity}:{sourceDatabasePath:string;backupDirectory:string;purpose:BackupPurpose;expectedSource?:{version:number;fingerprint:string};artifactIdentity?:ArtifactIdentity}):Promise<{artifact:BackupArtifact;retentionWarnings:BackupRetentionWarning[]}> {
  const root=canonicalRoot(backupDirectory,{create:true});
  const identity=artifactIdentity||{timestamp:Date.now(),nonce:randomUUID().replaceAll('-','')};
  if(!Number.isSafeInteger(identity.timestamp)||identity.timestamp<0||!/^[0-9a-f]{32}$/.test(identity.nonce))fail('백업 artifact identity가 올바르지 않습니다.');
  const createdAt=new Date(identity.timestamp).toISOString();
  const basename=formatBasename(sourceDatabasePath,purpose,identity),destination=path.join(root,basename),finalManifest=manifestPath(destination),temporary=path.join(root,`.${basename}.${randomUUID()}.tmp`),temporaryManifest=`${temporary}.manifest.json`;
  let sqlitePublished=false,manifestPublished=false;
  try {
    await backup(source,temporary);
    const candidate=new DatabaseSync(temporary,{readOnly:true});
    let validated:{schemaVersion:number;fingerprint:string};
    try { validated=validateCandidate(candidate,purpose,expectedSource); } finally { candidate.close(); }
    const size=statSync(temporary).size;
    if(size<=0)fail('생성된 백업 파일이 비어 있습니다.');
    const manifest:BackupManifest={manifest_version:1,backup_basename:basename,purpose,created_at:createdAt,byte_size:size,sha256:sha256(temporary),schema_version:validated.schemaVersion,schema_fingerprint:validated.fingerprint};
    writeFileSync(temporaryManifest,`${JSON.stringify(manifest)}\n`,{encoding:'utf8',flag:'wx'});
    publishExclusive(temporary,destination);sqlitePublished=true;
    try {publishExclusive(temporaryManifest,finalManifest);manifestPublished=true;}
    catch(error){if(sqlitePublished)bestEffortRemove(destination);throw error;}
    bestEffortRemove(temporary);bestEffortRemove(temporaryManifest);
    const retentionWarnings=applyBackupRetention(sourceDatabasePath,root,{protectedBasenames:[basename]});
    return {artifact:{basename,purpose,created_at:manifest.created_at,size:manifest.byte_size,schema_version:manifest.schema_version,verified:true},retentionWarnings};
  } catch(error) {
    bestEffortRemove(temporary);bestEffortRemove(temporaryManifest);
    if(sqlitePublished&&!manifestPublished)bestEffortRemove(destination);
    throw error;
  }
}

export function verifyBackupArtifactDetailed(sourceDatabasePath:string,backupDirectory:string,basename:string):VerifiedBackupArtifact {
  const root=canonicalRoot(backupDirectory),{databasePath,manifestPath:canonicalManifestPath,manifest,manifestSha256}=readManifest(root,sourceDatabasePath,basename),actualSha256=sha256(databasePath);
  if(actualSha256!==manifest.sha256)fail('백업 SHA-256이 manifest와 일치하지 않습니다.');
  const candidate=new DatabaseSync(databasePath,{readOnly:true});
  try {
    const actual=validateCandidate(candidate,manifest.purpose,manifest.purpose==='migration_safety'?{version:manifest.schema_version,fingerprint:manifest.schema_fingerprint}:undefined);
    if(actual.schemaVersion!==manifest.schema_version||actual.fingerprint!==manifest.schema_fingerprint)fail('백업 schema fingerprint가 manifest와 일치하지 않습니다.');
  } finally { candidate.close(); }
  const artifact={basename,purpose:manifest.purpose,created_at:manifest.created_at,size:manifest.byte_size,schema_version:manifest.schema_version,verified:true} as BackupArtifact;
  return {artifact,identity:{basename,canonicalBackupPath:databasePath,canonicalManifestPath,sha256:actualSha256,manifestSha256,byteSize:manifest.byte_size,purpose:manifest.purpose,schemaVersion:manifest.schema_version,schemaFingerprint:manifest.schema_fingerprint,manifestVersion:manifest.manifest_version}};
}

export function verifyBackupArtifact(sourceDatabasePath:string,backupDirectory:string,basename:string):BackupArtifact {
  return verifyBackupArtifactDetailed(sourceDatabasePath,backupDirectory,basename).artifact;
}

function scanBackupArtifacts(sourceDatabasePath:string,backupDirectory:string):BackupArtifact[] {
  const root=canonicalRoot(backupDirectory);
  const artifacts:BackupArtifact[]=[];
  for(const basename of readdirSync(root)){
    if(!parseBasename(sourceDatabasePath,basename))continue;
    try {const {manifest}=readManifest(root,sourceDatabasePath,basename);artifacts.push({basename,purpose:manifest.purpose,created_at:manifest.created_at,size:manifest.byte_size,schema_version:manifest.schema_version,verified:true});}catch{}
  }
  return artifacts.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.basename.localeCompare(a.basename));
}
export function listBackupArtifacts(sourceDatabasePath:string,backupDirectory:string):BackupArtifact[] {
  if(!existsSync(backupDirectory))return [];
  try{return scanBackupArtifacts(sourceDatabasePath,backupDirectory)}catch{return []}
}

export function applyBackupRetention(sourceDatabasePath:string,backupDirectory:string,{keepCount=20,maxAgeDays=90,now=Date.now(),protectedBasenames=[]}:{keepCount?:number;maxAgeDays?:number;now?:number;protectedBasenames?:string[]}={}):BackupRetentionWarning[] {
  const warnings:BackupRetentionWarning[]=[],protectedSet=new Set(protectedBasenames);
  if(!Number.isInteger(keepCount)||keepCount<1||!Number.isFinite(maxAgeDays)||maxAgeDays<0)fail('백업 보존 정책 설정이 올바르지 않습니다.');
  const groups=new Map<BackupPurpose,BackupArtifact[]>();let artifacts:BackupArtifact[];
  try {artifacts=scanBackupArtifacts(sourceDatabasePath,backupDirectory);} catch(error) {console.error('[backup] retention scan failed',error);return [{code:'retention_cleanup_failed'}];}
  for(const artifact of artifacts){const group=groups.get(artifact.purpose)||[];group.push(artifact);groups.set(artifact.purpose,group);}
  for(const artifacts of groups.values()){
    artifacts.sort((a,b)=>b.created_at.localeCompare(a.created_at)||b.basename.localeCompare(a.basename));
    for(const [index,artifact] of artifacts.entries()){
      if(protectedSet.has(artifact.basename))continue;
      const age=now-Date.parse(artifact.created_at);
      if(index<keepCount||!Number.isFinite(age)||age<=maxAgeDays*86400000)continue;
      try {const root=canonicalRoot(backupDirectory);const databasePath=regularFileInside(root,artifact.basename),sidecar=regularFileInside(root,manifestPath(artifact.basename));rmSync(databasePath);rmSync(sidecar);} catch(error) {console.error('[backup] retention cleanup failed',error);warnings.push({code:'retention_cleanup_failed',basename:artifact.basename});}
    }
  }
  return warnings;
}
