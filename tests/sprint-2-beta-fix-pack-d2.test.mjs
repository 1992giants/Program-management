import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('Sprint 2 Beta D2 rejects ambiguous imports and derives certificates from canonical attendance',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-beta-d2-'));
  const databasePath=path.join(directory,'beta-d2.sqlite');
  const source=String.raw`
    import assert from 'node:assert/strict';
    import { POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';
    const db=getDatabase(),today='2026-09-18',origin='http://localhost:3000';
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-D2','d2-admin','D2 관리자',hashPin('d2-admin','86420975'),'관리자',today);
    const addProgram=db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?, '회복','집단',2,'매주','센터','담당자',20,'운영 중',?)");
    for(const [id,name] of [['PA','동일 프로그램'],['PB','동일 프로그램'],['PU','유일 프로그램'],['PC','확인서 A'],['PD','확인서 B']])addProgram.run(id,name,today);
    const addRun=db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,'진행 중')");
    for(const [id,program,round,label] of [['RA1','PA',1,'중복 차수'],['RA2','PA',2,'중복 차수'],['RA3','PA',3,'선택 차수'],['RB1','PB',1,'외부 차수'],['RU1','PU',1,'유일 차수'],['RCA','PC',1,'A 차수'],['RCB','PD',1,'B 차수']])addRun.run(id,program,round,label,today);
    for(const [id,run,number] of [['SCA1','RCA',1],['SCA2','RCA',2],['SCB1','RCB',1]])db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,'10:00','센터')").run(id,run,number,today);
    for(const [id,name,phone] of [['P-CERT','확인서 대상','010-1111-0001'],['P-NONE','출석 없음','010-1111-0002'],['P-OTHER','다른 참가자','010-1111-0003']])db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'미입력',0,?,'비회원','',?)").run(id,name,phone,today);
    const addApplication=db.prepare("INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (?,?,?,?,?,'참가완료',?)");
    addApplication.run(1,'P-CERT','PC','RCA',today,1);addApplication.run(2,'P-NONE','PC','RCA',today,2);addApplication.run(3,'P-CERT','PD','RCB',today,3);
    db.prepare("INSERT INTO attendance (application_id,session_id,status,note) VALUES (1,'SCA1','참석',''),(1,'SCA2','보강','')").run();
    const request=body=>new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify(body)});
    const login=await POST(request({action:'login',username:'d2-admin',pin:'86420975'}));const cookie=login.headers.get('set-cookie').split(';')[0];
    const post=body=>POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie},body:JSON.stringify(body)}));
    let response=await post({action:'import',rows:[{name:'모호 프로그램',phone:'010-2000-0001',programName:'동일 프로그램'}]});let body=await response.json();assert.equal(response.status,200);assert.equal(body.importResult.rejected[0].code,'program_ambiguous');
    response=await post({action:'import',programId:'PA',rows:[{name:'명시 프로그램',phone:'010-2000-0002'}]});body=await response.json();assert.equal(body.importResult.acceptedRows,1);assert.equal(db.prepare("SELECT program_id FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name='명시 프로그램'").get().program_id,'PA');
    response=await post({action:'import',rows:[{name:'유일 프로그램',phone:'010-2000-0003',programName:'유일 프로그램',runLabel:'유일 차수'}]});body=await response.json();assert.equal(body.importResult.acceptedRows,1);assert.equal(db.prepare("SELECT run_id FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name='유일 프로그램'").get().run_id,'RU1');
    response=await post({action:'import',programId:'PA',rows:[{name:'모호 차수',phone:'010-2000-0004',runLabel:'중복 차수'}]});body=await response.json();assert.equal(body.importResult.rejected[0].code,'run_ambiguous');
    response=await post({action:'import',programId:'PA',runId:'RA3',rows:[{name:'명시 차수',phone:'010-2000-0005'}]});body=await response.json();assert.equal(body.importResult.acceptedRows,1);assert.equal(db.prepare("SELECT run_id FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name='명시 차수'").get().run_id,'RA3');
    response=await post({action:'import',programId:'PA',runId:'RA3',rows:[{name:'차수 불일치',phone:'010-2000-0006',runLabel:'중복 차수'}]});body=await response.json();assert.equal(body.importResult.rejected[0].code,'run_context_mismatch');
    response=await post({action:'import',programId:'PA',rows:[{name:'다른 프로그램 차수',phone:'010-2000-0007',runLabel:'외부 차수'}]});body=await response.json();assert.equal(body.importResult.rejected[0].code,'program_run_mismatch');
    const certificatesBefore=db.prepare('SELECT COUNT(*) AS count FROM certificates').get().count;
    response=await post({action:'certificate',applicationId:1,participantId:'P-OTHER',sessionCount:8});assert.equal(response.status,400);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM certificates').get().count,certificatesBefore);
    response=await post({action:'certificate',applicationId:2,sessionCount:8});assert.equal(response.status,400);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM certificates').get().count,certificatesBefore);
    response=await post({action:'certificate',applicationId:3,sessionCount:8});assert.equal(response.status,400);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM certificates').get().count,certificatesBefore);
    response=await post({action:'certificate',applicationId:1,sessionCount:8});body=await response.json();assert.equal(response.status,200);assert.equal(body.issuedCertificate.sessionCount,2);assert.equal(db.prepare('SELECT session_count FROM certificates ORDER BY id DESC LIMIT 1').get().session_count,2);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='certificate_create'").get().count,1);
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});
