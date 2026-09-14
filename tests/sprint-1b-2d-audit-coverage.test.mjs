import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('core lifecycle and import mutations record canonical minimized audits',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-audit-coverage-'));
  const databasePath=path.join(directory,'audit-coverage.sqlite');
  const source=String.raw`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-13';
    const sentinels=['PHONE_SECRET','NOTE_SECRET','STATUS_REASON_SECRET','SCHEDULE_TITLE_SECRET','ASSESSMENT_VALUE_SECRET','PIN_SECRET','SESSION_SECRET','EXCEL_ROW_SECRET'];
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-AUDIT-COVERAGE','audit-coverage','감사 관리자',hashPin('audit-coverage','86420975'),'관리자',today);

    const request=(method,url,cookie,body)=>new Request(origin+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const post=(body,cookie='')=>POST(request('POST','/api/data',cookie,body));
    const loginResponse=await post({action:'login',username:'audit-coverage',pin:'86420975'});assert.equal(loginResponse.status,200);const cookie=loginResponse.headers.get('set-cookie').split(';')[0];
    const auditRows=(action)=>db.prepare('SELECT * FROM audit_logs WHERE action=? ORDER BY id').all(action);
    const lastAudit=(action)=>db.prepare('SELECT * FROM audit_logs WHERE action=? ORDER BY id DESC LIMIT 1').get(action);

    const failedProgramAuditCount=auditRows('program_create').length;
    const invalidProgram=await post({action:'createProgram',name:'',deliveryType:'집단',category:'회복',sessionCount:2,recurrence:'매주',location:'센터',manager:'담당자',capacity:10,runLabel:'1차',startDate:today,time:'10:00'},cookie);
    assert.equal(invalidProgram.status,400);assert.equal(auditRows('program_create').length,failedProgramAuditCount);

    const createProgram=await post({action:'createProgram',name:'감사 프로그램',deliveryType:'집단',category:'ASSESSMENT_VALUE_SECRET',sessionCount:2,recurrence:'매주',location:'SCHEDULE_TITLE_SECRET',manager:'NOTE_SECRET',capacity:10,runLabel:'STATUS_REASON_SECRET',startDate:today,time:'10:00'},cookie);
    assert.equal(createProgram.status,200);
    const program=db.prepare('SELECT id FROM programs WHERE name=?').get('감사 프로그램'),run=db.prepare('SELECT id FROM program_runs WHERE program_id=? AND round_number=1').get(program.id);
    assert.ok(program?.id);assert.ok(run?.id);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE run_id=?').get(run.id).count,2);
    const programAudit=lastAudit('program_create'),programAfter=JSON.parse(programAudit.after_json);
    assert.equal(programAudit.entity_type,'프로그램');assert.equal(programAudit.entity_id,program.id);assert.deepEqual(programAfter,{run_id:run.id,session_count:2,capacity_present:true,manager_present:true});

    const runAuditCount=auditRows('run_create').length;
    const missingRun=await post({action:'createRun',programId:'PRG-NOT-FOUND',label:'1차',startDate:today,time:'11:00'},cookie);
    assert.equal(missingRun.status,400);assert.equal(auditRows('run_create').length,runAuditCount);
    const createRun=await post({action:'createRun',programId:program.id,label:'EXCEL_ROW_SECRET',startDate:today,time:'11:00'},cookie);
    assert.equal(createRun.status,200);
    const secondRun=db.prepare('SELECT id,program_id FROM program_runs WHERE program_id=? AND round_number=2').get(program.id),runAudit=lastAudit('run_create'),runAfter=JSON.parse(runAudit.after_json);
    assert.equal(runAudit.entity_type,'차수');assert.equal(runAudit.entity_id,secondRun.id);assert.deepEqual(runAfter,{program_id:program.id,session_count:2});

    const originalProgram=structuredClone(db.prepare('SELECT * FROM programs WHERE id=?').get(program.id)),updateAuditCount=auditRows('program_update').length;
    const missingUpdate=await post({action:'updateProgram',id:'PRG-NOT-FOUND',name:'SESSION_SECRET',deliveryType:'집단',category:'NOTE_SECRET',location:'PHONE_SECRET',manager:'PIN_SECRET',capacity:12,status:'일시 중단'},cookie);
    assert.equal(missingUpdate.status,400);assert.equal(auditRows('program_update').length,updateAuditCount);assert.equal(JSON.stringify(db.prepare('SELECT * FROM programs WHERE id=?').get(program.id)),JSON.stringify(originalProgram));
    const updateProgram=await post({action:'updateProgram',id:program.id,name:'SESSION_SECRET',deliveryType:'집단',category:'NOTE_SECRET',location:'PHONE_SECRET',manager:'PIN_SECRET',capacity:12,status:'일시 중단'},cookie);
    assert.equal(updateProgram.status,200);
    const updatedProgram=db.prepare('SELECT id,name,category,delivery_type,location,manager,capacity,status FROM programs WHERE id=?').get(program.id),programUpdateAudit=lastAudit('program_update'),programUpdateAfter=JSON.parse(programUpdateAudit.after_json);
    assert.equal(programUpdateAudit.entity_id,updatedProgram.id);assert.equal(updatedProgram.location,'PHONE_SECRET');assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE run_id IN (SELECT id FROM program_runs WHERE program_id=?) AND location=?').get(program.id,'PHONE_SECRET').count,4);
    assert.deepEqual(programUpdateAfter.changed_fields,['name','category','location','manager','capacity','status']);assert.equal(programUpdateAfter.status_before,'운영 중');assert.equal(programUpdateAfter.status_after,'일시 중단');assert.equal(programUpdateAfter.session_location_updated,true);assert.equal(programUpdateAfter.affected_session_count,4);

    db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-IMPORT-EXISTING','기존 참가자','미입력',0,'PHONE_SECRET','회원','NOTE_SECRET',today);
    db.prepare("INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_reason) VALUES (?,?,NULL,?,'취소',1,?)").run('P-IMPORT-EXISTING',program.id,today,'STATUS_REASON_SECRET');
    const importAuditCount=auditRows('import_complete').length;
    const invalidImport=await post({action:'import',rows:'EXCEL_ROW_SECRET'},cookie);assert.equal(invalidImport.status,400);assert.equal(auditRows('import_complete').length,importAuditCount);
    const importResponse=await post({action:'import',rows:[
      {name:'EXCEL_ROW_SECRET 신규',gender:'미입력',age:0,phone:'PHONE_SECRET 신규',memberStatus:'비회원',programName:'SESSION_SECRET',appliedAt:today,note:'NOTE_SECRET'},
      {name:'기존 참가자',gender:'미입력',age:0,phone:'PHONE_SECRET',memberStatus:'회원',programName:'SESSION_SECRET',appliedAt:today,statusReason:'STATUS_REASON_SECRET'},
      {name:'',phone:'SCHEDULE_TITLE_SECRET',programName:'SESSION_SECRET'},
      {name:'NOTE_SECRET 미배정',phone:'SCHEDULE_TITLE_SECRET',programName:'존재하지 않는 프로그램'},
    ]},cookie);
    assert.equal(importResponse.status,200);assert.equal(auditRows('import_complete').length,importAuditCount+1);
    const importAudit=lastAudit('import_complete'),importAfter=JSON.parse(importAudit.after_json);
    assert.equal(importAudit.entity_type,'가져오기');assert.match(importAudit.entity_id,/^IMPORT-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(importAfter,{processed_count:4,participant_created_count:1,participant_updated_count:0,application_created_count:1,application_updated_count:1,duplicate_count:1,rejected_count:2});
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants WHERE name=?').get('NOTE_SECRET 미배정').count,0);
    assert.equal(db.prepare('SELECT status FROM applications WHERE participant_id=? AND program_id=?').get('P-IMPORT-EXISTING',program.id).status,'신청');

    const allAudit=JSON.stringify(db.prepare('SELECT actor,action,entity_type,entity_id,before_json,after_json,summary,reason,ip_address FROM audit_logs').all());
    for(const sentinel of sentinels)assert.equal(allAudit.includes(sentinel),false,sentinel);
    const auditResponse=await GET(request('GET','/api/data?resource=audit',cookie));assert.equal(auditResponse.status,200);
    console.log(JSON.stringify({ok:true,programId:program.id,runId:secondRun.id,importId:importAudit.entity_id}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.equal(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).ok,true);
    const scan=spawnSync(process.execPath,['scripts/audit-sensitive-scan.mjs','--database',databasePath],{cwd:projectRoot,encoding:'utf8'});
    assert.equal(scan.status,0,scan.stderr||scan.stdout);assert.equal(JSON.parse(scan.stdout).suspected_rows,0);
  }finally{rmSync(directory,{recursive:true,force:true})}
});
