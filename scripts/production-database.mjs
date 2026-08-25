const requestedModes=new Set(process.argv.slice(2));
const supportedModes=new Set(['initialize','adopt','migrate','validate']);
const {existsSync,rmSync}=await import('node:fs');

if(!requestedModes.size||[...requestedModes].some(mode=>!supportedModes.has(mode))||requestedModes.has('validate')&&requestedModes.size!==1||requestedModes.has('initialize')&&requestedModes.size!==1){
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
  const {getDatabase,getDatabasePath}=await import('../db/index.ts');
  databasePath=getDatabasePath();
  databaseExisted=existsSync(databasePath);
  db=getDatabase();
  const integrity=db.prepare('PRAGMA integrity_check').all();
  if(integrity.length!==1||integrity[0].integrity_check!=='ok')throw new Error('SQLite integrity_check failed.');

  const settings=Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN ('application_id','database_environment','usr_admin_migration_completed')").all().map(row=>[row.key,row.value]));
  if(settings.application_id!=='onmaeum-program-care'||settings.database_environment!=='production')throw new Error('Production database marker validation failed.');
  const administrators=db.prepare("SELECT COUNT(*) AS count FROM staff_users WHERE role='관리자' AND active=1").get().count;
  if(administrators<1)throw new Error('An active production administrator is required.');
  if(requestedModes.has('migrate')&&settings.usr_admin_migration_completed!=='1')throw new Error('USR-ADMIN migration completion marker is missing.');

  console.log(JSON.stringify({ok:true,operation:[...requestedModes].join('+'),integrity:'ok',productionMarker:true,activeAdministrator:true}));
} catch(error) {
  if(requestedModes.has('initialize')&&!databaseExisted&&databasePath){
    try { db?.close(); } catch {}
    rmSync(databasePath,{force:true});
    rmSync(`${databasePath}-journal`,{force:true});
  }
  console.error(`Production database command failed: ${error instanceof Error?error.message:'Unknown error'}`);
  process.exitCode=1;
}
