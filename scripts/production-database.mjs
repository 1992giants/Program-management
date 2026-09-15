const arguments_=process.argv.slice(2),requestedModes=new Set(arguments_);
const supportedModes=new Set(['initialize','adopt','migrate','migrate-schema','validate','check-backup']);
const {existsSync,rmSync}=await import('node:fs');

const checkBackup=arguments_[0]==='check-backup';
if(!requestedModes.size||checkBackup&&arguments_.length!==2||!checkBackup&&[...requestedModes].some(mode=>!supportedModes.has(mode))||requestedModes.has('validate')&&requestedModes.size!==1||requestedModes.has('initialize')&&requestedModes.size!==1||requestedModes.has('migrate-schema')&&requestedModes.size!==1){
  console.error('Production database command is invalid.');
  process.exit(2);
}

process.env.NODE_ENV='production';
delete process.env.ONMAEUM_INITIALIZE_PRODUCTION_DB;
delete process.env.ONMAEUM_ADOPT_PRODUCTION_DB;
delete process.env.ONMAEUM_MIGRATE_USR_ADMIN;

if(requestedModes.has('validate')){
  delete process.env.ONMAEUM_BOOTSTRAP_ADMIN_USERNAME;
  delete process.env.ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME;
  delete process.env.ONMAEUM_BOOTSTRAP_ADMIN_PIN;
}
if(requestedModes.has('initialize'))process.env.ONMAEUM_INITIALIZE_PRODUCTION_DB='1';
if(requestedModes.has('adopt'))process.env.ONMAEUM_ADOPT_PRODUCTION_DB='1';
if(requestedModes.has('migrate'))process.env.ONMAEUM_MIGRATE_USR_ADMIN='1';

let databasePath='';
let databaseExisted=false;
let db;
try {
  const {adoptProductionDatabaseExplicitly,getBackupDirectory,getDatabase,getDatabasePath,migrateLegacyAdministratorExplicitly,migrateProductionSchemaExplicitly,validateProductionDatabaseReadOnly}=await import('../db/index.ts');
  databasePath=getDatabasePath();
  databaseExisted=existsSync(databasePath);
  let result;
  if(checkBackup){
    const {verifyBackupArtifact}=await import('../db/backup-management.ts');
    result=verifyBackupArtifact(databasePath,getBackupDirectory(),arguments_[1]);
  } else if(requestedModes.has('validate'))result=validateProductionDatabaseReadOnly();
  else if(requestedModes.has('migrate-schema'))result=await migrateProductionSchemaExplicitly();
  else if(requestedModes.has('initialize')){
    process.env.ONMAEUM_INITIALIZE_PRODUCTION_DB='1';
    db=getDatabase();
    result=validateProductionDatabaseReadOnly();
  } else {
    if(requestedModes.has('adopt'))result=adoptProductionDatabaseExplicitly();
    if(requestedModes.has('migrate'))result={...(result||{}),...migrateLegacyAdministratorExplicitly()};
    const adoptedKnownV0=requestedModes.has('adopt')&&!requestedModes.has('migrate')&&result?.version===0;
    if(!adoptedKnownV0)result={...(result||{}),...validateProductionDatabaseReadOnly()};
  }
  console.log(JSON.stringify({ok:true,operation:[...requestedModes].join('+'),...result}));
} catch(error) {
  if(requestedModes.has('initialize')&&!databaseExisted&&databasePath){
    try { db?.close(); } catch {}
    rmSync(databasePath,{force:true});
    rmSync(`${databasePath}-journal`,{force:true});
  }
  console.error(`Production database command failed: ${error instanceof Error?error.message:'Unknown error'}`);
  process.exitCode=1;
}
