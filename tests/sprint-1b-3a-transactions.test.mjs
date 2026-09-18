import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('transaction hardening rolls back partial business writes and audit failures',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-transactions-'));
  const databasePath=path.join(directory,'transactions.sqlite');
  const source=String.raw`
    import assert from 'node:assert/strict';
    import { POST } from './app/api/data/route.ts';
    import { getDatabase } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-14';
    db.prepare("UPDATE staff_users SET must_change_pin=0 WHERE username='test-owner'").run();
    const request=(body,cookie='')=>new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)});
    const post=(body,cookie='')=>POST(request(body,cookie));
    const login=await post({action:'login',username:'test-owner',pin:'97531086'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const count=(table,where='1=1',...params)=>db.prepare('SELECT COUNT(*) AS count FROM '+table+' WHERE '+where).get(...params).count;
    const auditCount=action=>count('audit_logs','action=?',action);
    const failAudit=action=>db.exec("CREATE TRIGGER fail_audit BEFORE INSERT ON audit_logs WHEN NEW.action='"+action+"' BEGIN SELECT RAISE(ABORT,'test audit failure'); END");
    const drop=name=>db.exec('DROP TRIGGER '+name);

    for(const [id,name] of [['PRG-TX-A','TX Program A'],['PRG-TX-B','TX Program B']])db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,'집단',2,'매주','BASE','담당자',10,'운영 중',?)").run(id,name,'회복',today);
    db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES ('RUN-PRG-TX-A-1','PRG-TX-A',1,'1차',?,'진행 중')").run(today);
    for(const number of [1,2])db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)').run('SESSION-TX-'+number,'RUN-PRG-TX-A-1',number,today,'10:00','BASE');

    const registrationAudit=auditCount('등록');
    db.exec("CREATE TRIGGER fail_second_application BEFORE INSERT ON applications WHEN NEW.program_id='PRG-TX-B' BEGIN SELECT RAISE(ABORT,'test application failure'); END");
    let response=await post({action:'createParticipant',name:'참가자 부분실패',gender:'미입력',age:0,phone:'010-1000-1000',memberStatus:'비회원',note:'',programIds:['PRG-TX-A','PRG-TX-B']},cookie);
    assert.equal(response.status,500);assert.equal(count('participants','name=?','참가자 부분실패'),0);assert.equal(auditCount('등록'),registrationAudit);drop('fail_second_application');

    failAudit('등록');
    response=await post({action:'createParticipant',name:'참가자 감사실패',gender:'미입력',age:0,phone:'010-1000-1001',memberStatus:'비회원',note:'',programIds:['PRG-TX-A']},cookie);
    assert.equal(response.status,500);assert.equal(count('participants','name=?','참가자 감사실패'),0);assert.equal(auditCount('등록'),registrationAudit);drop('fail_audit');

    const programCounts=()=>[count('programs'),count('program_runs'),count('sessions')];
    const baselineProgramCounts=programCounts(),programAudit=auditCount('program_create');
    db.exec("CREATE TRIGGER fail_run BEFORE INSERT ON program_runs WHEN NEW.label='RUN FAIL' BEGIN SELECT RAISE(ABORT,'test run failure'); END");
    response=await post({action:'createProgram',name:'프로그램 차수실패',deliveryType:'집단',category:'회복',sessionCount:2,recurrence:'매주',location:'센터',manager:'담당자',capacity:10,runLabel:'RUN FAIL',startDate:today,time:'10:00'},cookie);
    assert.equal(response.status,500);assert.deepEqual(programCounts(),baselineProgramCounts);assert.equal(auditCount('program_create'),programAudit);drop('fail_run');

    db.exec("CREATE TRIGGER fail_session BEFORE INSERT ON sessions WHEN NEW.session_number=2 AND NEW.location='SESSION FAIL' BEGIN SELECT RAISE(ABORT,'test session failure'); END");
    response=await post({action:'createProgram',name:'프로그램 회기실패',deliveryType:'집단',category:'회복',sessionCount:2,recurrence:'매주',location:'SESSION FAIL',manager:'담당자',capacity:10,runLabel:'1차',startDate:today,time:'10:00'},cookie);
    assert.equal(response.status,500);assert.deepEqual(programCounts(),baselineProgramCounts);assert.equal(auditCount('program_create'),programAudit);drop('fail_session');

    failAudit('program_create');
    response=await post({action:'createProgram',name:'프로그램 감사실패',deliveryType:'집단',category:'회복',sessionCount:2,recurrence:'매주',location:'센터',manager:'담당자',capacity:10,runLabel:'1차',startDate:today,time:'10:00'},cookie);
    assert.equal(response.status,500);assert.deepEqual(programCounts(),baselineProgramCounts);assert.equal(auditCount('program_create'),programAudit);drop('fail_audit');

    const runAudit=auditCount('run_create');
    db.exec("CREATE TRIGGER fail_run_second_session BEFORE INSERT ON sessions WHEN NEW.run_id='RUN-PRG-TX-A-2' AND NEW.session_number=2 BEGIN SELECT RAISE(ABORT,'test second session failure'); END");
    response=await post({action:'createRun',programId:'PRG-TX-A',label:'2차',startDate:today,time:'11:00'},cookie);
    assert.equal(response.status,500);assert.equal(count('program_runs','id=?','RUN-PRG-TX-A-2'),0);assert.equal(count('sessions','run_id=?','RUN-PRG-TX-A-2'),0);assert.equal(auditCount('run_create'),runAudit);drop('fail_run_second_session');

    const originalProgram=db.prepare("SELECT name,category,delivery_type,location,manager,capacity,status FROM programs WHERE id='PRG-TX-A'").get(),updateAudit=auditCount('program_update');
    db.exec("CREATE TRIGGER fail_session_update BEFORE UPDATE ON sessions WHEN NEW.location='FAIL LOCATION' BEGIN SELECT RAISE(ABORT,'test session update failure'); END");
    response=await post({action:'updateProgram',id:'PRG-TX-A',name:'변경 이름',deliveryType:'집단',category:'회복',location:'FAIL LOCATION',manager:'담당자',capacity:10,status:'운영 중'},cookie);
    assert.equal(response.status,500);assert.deepEqual(db.prepare("SELECT name,category,delivery_type,location,manager,capacity,status FROM programs WHERE id='PRG-TX-A'").get(),originalProgram);assert.equal(count('sessions','run_id=? AND location<>?','RUN-PRG-TX-A-1','BASE'),0);assert.equal(auditCount('program_update'),updateAudit);drop('fail_session_update');
    failAudit('program_update');
    response=await post({action:'updateProgram',id:'PRG-TX-A',name:'감사 실패 이름',deliveryType:'집단',category:'회복',location:'AUDIT FAIL LOCATION',manager:'담당자',capacity:10,status:'운영 중'},cookie);
    assert.equal(response.status,500);assert.deepEqual(db.prepare("SELECT name,category,delivery_type,location,manager,capacity,status FROM programs WHERE id='PRG-TX-A'").get(),originalProgram);assert.equal(count('sessions','run_id=? AND location<>?','RUN-PRG-TX-A-1','BASE'),0);assert.equal(auditCount('program_update'),updateAudit);drop('fail_audit');

    const importAudit=auditCount('import_complete');
    response=await post({action:'import',rows:[
      {name:'가져오기 정상 1',phone:'010-2000-0001',programName:'TX Program A'},
      {name:'가져오기 거부',phone:'010-2000-0002',programName:'없는 프로그램'},
      {name:'가져오기 정상 2',phone:'010-2000-0003',programName:'TX Program A'},
    ]},cookie);
    assert.equal(response.status,200);assert.equal(count('participants',"name LIKE '가져오기 정상 %'"),2);assert.equal(count('participants','name=?','가져오기 거부'),0);assert.equal(auditCount('import_complete'),importAudit+1);
    const importMetadata=JSON.parse(db.prepare("SELECT after_json FROM audit_logs WHERE action='import_complete' ORDER BY id DESC LIMIT 1").get().after_json);assert.equal(importMetadata.total_rows,3);assert.equal(importMetadata.created_participants,2);assert.equal(importMetadata.created_applications,2);assert.equal(importMetadata.rejected_rows,1);

    db.exec("CREATE TRIGGER fail_import_third BEFORE INSERT ON participants WHEN NEW.name='가져오기 DB 실패 3' BEGIN SELECT RAISE(ABORT,'test import failure'); END");
    response=await post({action:'import',rows:[
      {name:'가져오기 DB 실패 1',phone:'010-3000-0001',programName:'TX Program A'},
      {name:'가져오기 DB 실패 2',phone:'010-3000-0002',programName:'TX Program A'},
      {name:'가져오기 DB 실패 3',phone:'010-3000-0003',programName:'TX Program A'},
    ]},cookie);
    assert.equal(response.status,500);assert.equal(count('participants',"name LIKE '가져오기 DB 실패 %'"),0);assert.equal(auditCount('import_complete'),importAudit+1);drop('fail_import_third');
    failAudit('import_complete');
    response=await post({action:'import',rows:[{name:'가져오기 감사실패 1',phone:'010-4000-0001',programName:'TX Program A'},{name:'가져오기 감사실패 2',phone:'010-4000-0002',programName:'TX Program A'}]},cookie);
    assert.equal(response.status,500);assert.equal(count('participants',"name LIKE '가져오기 감사실패 %'"),0);assert.equal(auditCount('import_complete'),importAudit+1);drop('fail_audit');

    db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-TX-EXISTING','기존 참가자','미입력',0,'010-5000-0000','회원','',?)").run(today);
    const applicationId=Number(db.prepare("INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES ('P-TX-EXISTING','PRG-TX-A','RUN-PRG-TX-A-1',?,'참가중',50,?)").run(today,today).lastInsertRowid);
    db.prepare("INSERT OR IGNORE INTO program_assessments (program_id,assessment_id,sort_order) VALUES ('PRG-TX-A','ASM-PHQ9',0)").run();

    failAudit('상태 변경');response=await post({action:'applicationStatus',id:applicationId,status:'참가완료',reason:''},cookie);assert.equal(response.status,500);assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId).status,'참가중');drop('fail_audit');
    failAudit('출석 입력');response=await post({action:'attendance',applicationId,sessionId:'SESSION-TX-1',status:'참석',note:'',contactedAt:'',makeupForSessionId:''},cookie);assert.equal(response.status,500);assert.equal(count('attendance','application_id=? AND session_id=?',applicationId,'SESSION-TX-1'),0);drop('fail_audit');
    failAudit('일정 등록');response=await post({action:'createScheduleEvent',participantId:'P-TX-EXISTING',title:'감사 실패 일정',eventDate:today,eventType:'상담',color:'green',allDay:true,startTime:'',endTime:'',recurrence:'1회',deliveryMode:'대면'},cookie);assert.equal(response.status,500);assert.equal(count('schedule_events','title=?','감사 실패 일정'),0);drop('fail_audit');
    failAudit('certificate_create');const certificateCount=count('certificates');response=await post({action:'certificate',participantId:'P-TX-EXISTING',sessionCount:2},cookie);assert.equal(response.status,500);assert.equal(count('certificates'),certificateCount);drop('fail_audit');
    failAudit('검사 점수');response=await post({action:'saveAssessmentScore',programId:'PRG-TX-A',runId:'RUN-PRG-TX-A-1',applicationId,assessmentId:'ASM-PHQ9',preScore:10,postScore:8,note:'',preDate:today,postDate:today,notCompletedReason:''},cookie);assert.equal(response.status,500);assert.equal(count('assessment_scores','application_id=?',applicationId),0);drop('fail_audit');

    console.log(JSON.stringify({ok:true}));
  `;
  try {
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.equal(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)).ok,true);
  } finally {
    rmSync(directory,{recursive:true,force:true});
  }
});
