import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('remaining operational mutations record canonical minimized audits',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-operational-audit-'));
  const databasePath=path.join(directory,'operational-audit.sqlite');
  const source=String.raw`
    import assert from 'node:assert/strict';
    import { POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-14';
    const sentinels=['PHONE_SECRET','NOTE_SECRET','STATUS_REASON_SECRET','PIN_SECRET','SESSION_SECRET','FREE_TEXT_SECRET'];
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-OP-AUDIT','op-audit','운영 감사 관리자',hashPin('op-audit','86420975'),'관리자',today);
    const insertProgram=db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,'집단',1,'매주','센터','담당자',10,'운영 중',?)");
    insertProgram.run('PRG-OP-A','운영 프로그램 A','회복',today);insertProgram.run('PRG-OP-B','운영 프로그램 B','회복',today);
    const insertRun=db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,'모집 중')");
    insertRun.run('RUN-OP-A1','PRG-OP-A',1,'1차',today);insertRun.run('RUN-OP-A2','PRG-OP-A',2,'2차',today);insertRun.run('RUN-OP-B1','PRG-OP-B',1,'1차',today);
    const insertParticipant=db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)');
    for(const [id,name] of [['P-APPLY','신청 참가자'],['P-ASSIGN','배정 참가자'],['P-RUN-NEW','신규 차수 참가자'],['P-RUN-OLD','재배정 참가자']])insertParticipant.run(id,name,'미입력',0,'010-0000-0000','회원','',today);
    const insertApplication=db.prepare('INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_reason) VALUES (?,?,?,?,?,?,?)');
    insertApplication.run('P-ASSIGN','PRG-OP-A',null,today,'신청',1,'STATUS_REASON_SECRET');
    insertApplication.run('P-RUN-OLD','PRG-OP-A','RUN-OP-A1',today,'참가중',2,'STATUS_REASON_SECRET');

    const request=(body,cookie='')=>new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
    const post=(body,cookie='')=>POST(request(body,cookie));
    const login=await post({action:'login',username:'op-audit',pin:'86420975'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const auditRows=action=>db.prepare('SELECT * FROM audit_logs WHERE action=? ORDER BY id').all(action),lastAudit=action=>db.prepare('SELECT * FROM audit_logs WHERE action=? ORDER BY id DESC LIMIT 1').get(action);

    const registrationCount=auditRows('등록').length,participantCount=db.prepare('SELECT COUNT(*) AS count FROM participants').get().count;
    const invalidParticipant=await post({action:'createParticipant',name:'FREE_TEXT_SECRET invalid',gender:'미입력',age:0,phone:'PHONE_SECRET',memberStatus:'회원',note:'NOTE_SECRET',programIds:['PRG-NOT-FOUND']},cookie);
    assert.equal(invalidParticipant.status,400);assert.equal(auditRows('등록').length,registrationCount);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants').get().count,participantCount);
    const participantResponse=await post({action:'createParticipant',name:'FREE_TEXT_SECRET',gender:'미입력',age:0,phone:'PHONE_SECRET',memberStatus:'회원',note:'NOTE_SECRET SESSION_SECRET',programIds:['PRG-OP-B','PRG-OP-A','PRG-OP-A']},cookie);
    assert.equal(participantResponse.status,200);const createdParticipant=db.prepare('SELECT id FROM participants WHERE phone=?').get('PHONE_SECRET'),registrationAudit=lastAudit('등록'),registrationAfter=JSON.parse(registrationAudit.after_json);
    assert.equal(registrationAudit.entity_id,createdParticipant.id);assert.deepEqual(registrationAfter,{created:true,initial_application_count:2,initial_program_ids:['PRG-OP-A','PRG-OP-B']});

    let count=auditRows('application_apply').length;
    assert.equal((await post({action:'apply',participantId:'P-NOT-FOUND',programId:'PRG-OP-A'},cookie)).status,400);assert.equal(auditRows('application_apply').length,count);
    assert.equal((await post({action:'apply',participantId:'P-APPLY',programId:'PRG-OP-A',statusReason:'STATUS_REASON_SECRET'},cookie)).status,200);
    const applied=db.prepare('SELECT id,run_id,status FROM applications WHERE participant_id=? AND program_id=?').get('P-APPLY','PRG-OP-A'),applyCreated=lastAudit('application_apply');
    assert.equal(applyCreated.entity_id,String(applied.id));assert.deepEqual(JSON.parse(applyCreated.after_json),{participant_id:'P-APPLY',program_id:'PRG-OP-A',run_id:null,created:true,reapplied:false,status_before:null,status_after:'신청'});
    db.prepare("UPDATE applications SET status='취소',status_reason=? WHERE id=?").run('STATUS_REASON_SECRET',applied.id);
    assert.equal((await post({action:'apply',participantId:'P-APPLY',programId:'PRG-OP-A'},cookie)).status,200);const applyAgain=JSON.parse(lastAudit('application_apply').after_json);
    assert.equal(applyAgain.created,false);assert.equal(applyAgain.reapplied,true);assert.equal(applyAgain.status_before,'취소');assert.equal(applyAgain.status_after,'신청');

    count=auditRows('application_assign_run').length;
    assert.equal((await post({action:'assignRun',applicationId:999999,runId:'RUN-OP-A1'},cookie)).status,400);assert.equal(auditRows('application_assign_run').length,count);
    const assignApplication=db.prepare('SELECT id FROM applications WHERE participant_id=? AND program_id=?').get('P-ASSIGN','PRG-OP-A');
    assert.equal((await post({action:'assignRun',applicationId:assignApplication.id,runId:'RUN-OP-B1'},cookie)).status,400);assert.equal(auditRows('application_assign_run').length,count);
    assert.equal((await post({action:'assignRun',applicationId:assignApplication.id,runId:'RUN-OP-A1'},cookie)).status,200);const assignAudit=lastAudit('application_assign_run');
    assert.equal(assignAudit.entity_id,String(assignApplication.id));assert.deepEqual(JSON.parse(assignAudit.after_json),{run_before:null,run_after:'RUN-OP-A1',status_before:'신청',status_after:'참가대기',assigned:true});

    count=auditRows('application_apply_to_run').length;
    assert.equal((await post({action:'applyToRun',participantId:'P-NOT-FOUND',runId:'RUN-OP-A1'},cookie)).status,400);assert.equal(auditRows('application_apply_to_run').length,count);
    assert.equal((await post({action:'applyToRun',participantId:'P-RUN-NEW',runId:'RUN-OP-A1'},cookie)).status,200);const newRunApplication=db.prepare('SELECT id FROM applications WHERE participant_id=? AND program_id=?').get('P-RUN-NEW','PRG-OP-A'),newRunAudit=lastAudit('application_apply_to_run');
    assert.equal(newRunAudit.entity_id,String(newRunApplication.id));assert.deepEqual(JSON.parse(newRunAudit.after_json),{program_id:'PRG-OP-A',run_before:null,run_after:'RUN-OP-A1',status_before:null,status_after:'참가대기',created:true,reassigned:false});
    assert.equal((await post({action:'applyToRun',participantId:'P-RUN-OLD',runId:'RUN-OP-A2'},cookie)).status,200);const movedApplication=db.prepare('SELECT id FROM applications WHERE participant_id=? AND program_id=?').get('P-RUN-OLD','PRG-OP-A'),moveAudit=lastAudit('application_apply_to_run');
    assert.equal(moveAudit.entity_id,String(movedApplication.id));assert.deepEqual(JSON.parse(moveAudit.after_json),{program_id:'PRG-OP-A',run_before:'RUN-OP-A1',run_after:'RUN-OP-A2',status_before:'참가중',status_after:'참가대기',created:false,reassigned:true});

    db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES ('SESSION-OP-A1','RUN-OP-A1',1,?,'10:00','센터')").run(today);db.prepare("INSERT INTO attendance (application_id,session_id,status,note) VALUES (?, 'SESSION-OP-A1','참석','')").run(assignApplication.id);
    count=auditRows('certificate_create').length;
    assert.equal((await post({action:'certificate',applicationId:999999},cookie)).status,400);assert.equal((await post({action:'certificate',applicationId:applied.id},cookie)).status,400);assert.equal(auditRows('certificate_create').length,count);
    assert.equal((await post({action:'certificate',applicationId:assignApplication.id,sessionCount:3,freeText:'FREE_TEXT_SECRET'},cookie)).status,200);const certificate=db.prepare('SELECT id,participant_id,session_count FROM certificates ORDER BY id DESC LIMIT 1').get(),certificateAudit=lastAudit('certificate_create');
    assert.equal(certificateAudit.entity_id,String(certificate.id));assert.deepEqual(JSON.parse(certificateAudit.after_json),{participant_id:'P-ASSIGN',application_id:assignApplication.id,program_id:'PRG-OP-A',run_id:'RUN-OP-A1',session_count:1,issued:true});

    const previousSettings=Object.fromEntries(db.prepare("SELECT key,value FROM settings WHERE key IN ('center_name','manager_name')").all().map(item=>[item.key,item.value])),settingsCount=auditRows('settings_update').length;
    assert.equal((await post({action:'settings',centerName:'',managerName:'PIN_SECRET'},cookie)).status,400);assert.equal(auditRows('settings_update').length,settingsCount);assert.equal(db.prepare("SELECT value FROM settings WHERE key='center_name'").get().value,previousSettings.center_name);
    assert.equal((await post({action:'settings',centerName:'FREE_TEXT_SECRET',managerName:'PIN_SECRET SESSION_SECRET'},cookie)).status,200);const settingsAudit=lastAudit('settings_update');
    assert.equal(settingsAudit.entity_id,'system');assert.deepEqual(JSON.parse(settingsAudit.after_json),{changed_fields:['center_name','manager_name'],center_name_changed:true,manager_name_changed:true});
    count=auditRows('settings_update').length;assert.equal((await post({action:'settings',centerName:'FREE_TEXT_SECRET',managerName:'PIN_SECRET SESSION_SECRET'},cookie)).status,200);assert.equal(auditRows('settings_update').length,count);

    const allAudit=JSON.stringify(db.prepare('SELECT actor,action,entity_type,entity_id,before_json,after_json,summary,reason,ip_address FROM audit_logs').all());
    for(const sentinel of sentinels)assert.equal(allAudit.includes(sentinel),false,sentinel);
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});
