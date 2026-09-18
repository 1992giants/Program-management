import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('Sprint 2 Beta D1 protects historical applications and reports relation mismatches',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-beta-d1-'));
  const databasePath=path.join(directory,'beta-d1.sqlite');
  const source=String.raw`
    import assert from 'node:assert/strict';
    import { spawnSync } from 'node:child_process';
    import { POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';
    const db=getDatabase(),today='2026-09-18',origin='http://localhost:3000';
    const strictDeepEqual=assert.deepEqual;
    assert.deepEqual=(actual,expected,message)=>strictDeepEqual(actual&&Object.getPrototypeOf(actual)===null?{...actual}:actual,expected,message);
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-D1','d1-admin','D1 관리자',hashPin('d1-admin','86420975'),'관리자',today);
    db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES ('PRG-D1','D1 프로그램','회복','집단',1,'매주','센터','담당자',50,'운영 중',?)").run(today);
    for(const [id,round,label] of [['RUN-D1-A',1,'A차수'],['RUN-D1-B',2,'B차수'],['RUN-D1-C',3,'C차수'],['RUN-D1-D',4,'D차수'],['RUN-D1-E',5,'E차수']])db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,'PRG-D1',?,?,?,'진행 중')").run(id,round,label,today);
    for(const [id,run] of [['SES-D1-A','RUN-D1-A'],['SES-D1-B','RUN-D1-B'],['SES-D1-C','RUN-D1-C'],['SES-D1-D','RUN-D1-D'],['SES-D1-E','RUN-D1-E']])db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,1,?,'10:00','센터')").run(id,run,today);
    db.prepare("INSERT INTO assessment_catalog (id,name,min_score,max_score,active,created_at) VALUES ('ASM-D1','D1 검사',0,10,1,?)").run(today);
    const people=[['P-D1-A','취소 이력','010-1111-0001'],['P-D1-B','중도탈락 이력','010-1111-0002'],['P-D1-C','만족도 이력','010-1111-0003'],['P-D1-D','무이력','010-1111-0004'],['P-D1-E','확인서만','010-1111-0005'],['P-D1-F','불일치','010-1111-0006'],['P-D1-G','무이력 취소','010-1111-0007']];
    for(const [id,name,phone] of people)db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'미입력',0,?,'비회원','',?)").run(id,name,phone,today);
    const insertApp=db.prepare("INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,status_reason,queue_number) VALUES (?,?, 'PRG-D1', ?, ?, ?, ?, ?)");
    insertApp.run(1,'P-D1-A','RUN-D1-A',today,'취소','취소 사유',1);insertApp.run(2,'P-D1-B','RUN-D1-A',today,'중도탈락','탈락 사유',2);insertApp.run(3,'P-D1-C','RUN-D1-A',today,'참가중','',3);insertApp.run(4,'P-D1-D','RUN-D1-B',today,'참가대기','',4);insertApp.run(5,'P-D1-E','RUN-D1-D',today,'참가중','',5);insertApp.run(6,'P-D1-F','RUN-D1-A',today,'참가완료','',6);insertApp.run(7,'P-D1-G','RUN-D1-A',today,'취소','무이력 사유',7);
    db.prepare("INSERT INTO attendance (application_id,session_id,status,note) VALUES (1,'SES-D1-A','참석','')").run();
    db.prepare("INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at) VALUES (2,'ASM-D1',4,3,'',?)").run(today);
    db.prepare("INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at) VALUES (3,4,'',?)").run(today);
    db.prepare("INSERT INTO attendance (application_id,session_id,status,note) VALUES (6,'SES-D1-C','참석','')").run();
    db.prepare("INSERT INTO certificates (participant_id,issued_at,session_count) VALUES ('P-D1-E',?,1)").run(today);
    const request=body=>new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const login=await POST(request({action:'login',username:'d1-admin',pin:'86420975'}));const cookie=login.headers.get('set-cookie').split(';')[0];
    const post=body=>POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}));
    const auditBefore=db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    for(const applicationId of [1,2,3])assert.equal((await post({action:'removeFromRun',applicationId,runId:'RUN-D1-A'})).status,400);
    assert.equal(db.prepare('SELECT run_id FROM applications WHERE id=1').get().run_id,'RUN-D1-A');assert.equal(db.prepare('SELECT COUNT(*) AS count FROM attendance WHERE application_id=1').get().count,1);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,auditBefore);
    assert.equal((await post({action:'removeFromRun',applicationId:4,runId:'RUN-D1-B'})).status,200);assert.equal(db.prepare('SELECT run_id FROM applications WHERE id=4').get().run_id,null);    db.prepare("UPDATE applications SET run_id='RUN-D1-D' WHERE id=4").run();db.exec("CREATE TRIGGER remove_audit_abort BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'audit abort'); END");assert.equal((await post({action:'removeFromRun',applicationId:4,runId:'RUN-D1-D'})).status,500);db.exec('DROP TRIGGER remove_audit_abort');assert.equal(db.prepare('SELECT run_id FROM applications WHERE id=4').get().run_id,'RUN-D1-D');db.prepare('UPDATE applications SET run_id=NULL WHERE id=4').run();
    assert.equal((await post({action:'removeFromRun',applicationId:5,runId:'RUN-D1-D'})).status,200);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM certificates WHERE participant_id=?').get('P-D1-E').count,1);
    assert.equal((await post({action:'deleteRun',id:'RUN-D1-A'})).status,400);assert.equal((await post({action:'deleteRun',id:'RUN-D1-C'})).status,400);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id=?').get('SES-D1-C').count,1);assert.equal((await post({action:'deleteRun',id:'RUN-D1-B'})).status,200);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM program_runs WHERE id=?').get('RUN-D1-B').count,0);
    assert.equal((await post({action:'applyToRun',participantId:'P-D1-A',runId:'RUN-D1-A'})).status,400);assert.equal((await post({action:'applyToRun',participantId:'P-D1-B',runId:'RUN-D1-A'})).status,400);assert.equal((await post({action:'apply',participantId:'P-D1-A',programId:'PRG-D1'})).status,400);assert.deepEqual(db.prepare('SELECT run_id,status,status_reason FROM applications WHERE id=1').get(),{run_id:'RUN-D1-A',status:'취소',status_reason:'취소 사유'});
    const imported=await post({action:'import',rows:[{name:'취소 이력',phone:'01011110001',programName:'D1 프로그램',runLabel:'A차수'}]});assert.equal(imported.status,200);assert.equal((await imported.json()).importResult.rejected[0].code,'terminal_historical_reapplication');assert.deepEqual(db.prepare('SELECT run_id,status,status_reason FROM applications WHERE id=1').get(),{run_id:'RUN-D1-A',status:'취소',status_reason:'취소 사유'});
    assert.equal((await post({action:'applyToRun',participantId:'P-D1-G',runId:'RUN-D1-A'})).status,200);assert.equal(db.prepare('SELECT status FROM applications WHERE id=7').get().status,'참가대기');
    db.exec("CREATE TRIGGER audit_abort BEFORE INSERT ON audit_logs BEGIN SELECT RAISE(ABORT,'audit abort'); END");assert.equal((await post({action:'deleteRun',id:'RUN-D1-E'})).status,500);db.exec('DROP TRIGGER audit_abort');assert.equal(db.prepare('SELECT COUNT(*) AS count FROM program_runs WHERE id=?').get('RUN-D1-E').count,1);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sessions WHERE id=?').get('SES-D1-E').count,1);
    const diagnostic=spawnSync(process.execPath,['scripts/check-business-integrity.mjs','--database',process.env.ONMAEUM_TEST_DB_PATH],{cwd:process.cwd(),env:process.env,encoding:'utf8'});assert.equal(diagnostic.status,0,diagnostic.stderr);const report=JSON.parse(diagnostic.stdout);assert.equal(report.read_only,true);assert.equal(report.repair,'not_performed');assert.equal(report.issue_counts.attendance_run_mismatch,1);assert.equal(report.issues.attendance_run_mismatch[0].application_id,6);assert.equal(report.issues.attendance_run_mismatch[0].session_run_id,'RUN-D1-C');
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});
