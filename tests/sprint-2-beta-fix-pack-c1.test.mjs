import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('Beta C1 preserves withdrawn history and rejects unsafe lifecycle mutations',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-beta-c1-'));
  const databasePath=path.join(directory,'beta-c1.sqlite');
  const source=String.raw`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';
    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-18';
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-C1','c1-admin','C1 관리자',hashPin('c1-admin','86420975'),'관리자',today);
    db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES ('PRG-C1','C1 프로그램','회복','집단',1,'매주','센터','담당자',10,'운영 중',?)").run(today);
    for(const [id,round,label] of [['RUN-C1-A',1,'A차수'],['RUN-C1-B',2,'B차수']])db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,'PRG-C1',?,?,?,'진행 중')").run(id,round,label,today);
    db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location,attendance_status) VALUES ('SES-C1-A','RUN-C1-A',1,?,'10:00','센터','작성 중')").run(today);
    const people=[
      ['P-C1-H','이력 참가자','010-1000-0001'],['P-C1-F','신규 참가자','010-1000-0002'],
      ['P-C1-K','병합 대상','010-1000-0003'],['P-C1-S','병합 대상','010-1000-0003'],
      ['P-C1-C','완료 참가자','010-1000-0004'],['P-C1-X','취소 참가자','010-1000-0005'],
      ['P-C1-SK','단순 중복','010-1000-0006'],['P-C1-SS','단순 중복','010-1000-0006']
    ];
    for(const [id,name,phone] of people)db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'미입력',0,?,'비회원','',?)").run(id,name,phone,today);
    const insertApplication=db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (?,?,\'PRG-C1\',?,?,?,?)');
    insertApplication.run(101,'P-C1-H','RUN-C1-A',today,'참가중',1);
    insertApplication.run(102,'P-C1-F',null,today,'신청',2);
    insertApplication.run(103,'P-C1-K','RUN-C1-B',today,'참가중',3);
    insertApplication.run(104,'P-C1-S','RUN-C1-A',today,'참가중',4);
    insertApplication.run(105,'P-C1-C','RUN-C1-A',today,'참가완료',5);
    insertApplication.run(106,'P-C1-X','RUN-C1-A',today,'취소',6);
    for(const id of [101,104,105,106])db.prepare("INSERT INTO attendance (application_id,session_id,status,note) VALUES (?, 'SES-C1-A','참석',?)").run(id,'ATTENDANCE-'+id);
    db.prepare("INSERT INTO program_assessments (program_id,assessment_id,sort_order) VALUES ('PRG-C1','ASM-PHQ9',0)").run();
    for(const id of [101,104,105,106]){db.prepare("INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at) VALUES (?,'ASM-PHQ9',10,5,?,?)").run(id,'SCORE-'+id,today);db.prepare("INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at) VALUES (?,4,?,?)").run(id,'SAT-'+id,today)}
    const request=(method,url,body,cookie='')=>new Request(origin+url,{method,headers:{...(body?{Origin:origin,'Content-Type':'application/json'}:{}),...(cookie?{Cookie:cookie}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const post=(body,cookie)=>POST(request('POST','/api/data',body,cookie));
    const get=(url,cookie)=>GET(request('GET',url,null,cookie));
    const login=await post({action:'login',username:'c1-admin',pin:'86420975'});assert.equal(login.status,200);const cookie=login.headers.get('set-cookie').split(';')[0];
    const detail=await get('/api/data?resource=attendance&sessionId=SES-C1-A',cookie);assert.deepEqual((await detail.json()).attendance.map(row=>row.application_id),[101,104,105]);
    assert.equal((await post({action:'applicationStatus',id:101,status:'중도탈락',reason:'C1 사유'},cookie)).status,200);
    const afterWithdraw=await get('/api/data?resource=attendance&sessionId=SES-C1-A',cookie);const withdrawnAttendance=await afterWithdraw.json();assert.deepEqual(withdrawnAttendance.attendance.map(row=>row.application_id),[101,104,105]);assert.ok(JSON.stringify(withdrawnAttendance).includes('ATTENDANCE-101'));
    const outcomes=await get('/api/data?resource=outcomes&programId=PRG-C1&runId=RUN-C1-A',cookie);const outcomeBody=await outcomes.json();assert.deepEqual(outcomeBody.assessmentScores.map(row=>row.application_id),[101,104,105]);assert.deepEqual(outcomeBody.satisfactionSurveys.map(row=>row.application_id),[101,104,105]);
    const auditBefore=db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,historyBefore={...db.prepare('SELECT * FROM assessment_scores WHERE application_id=101').get()};
    assert.equal((await post({action:'attendance',applicationId:101,sessionId:'SES-C1-A',status:'결석',note:'수정 불가'},cookie)).status,400);
    assert.equal((await post({action:'saveAssessmentScore',applicationId:101,assessmentId:'ASM-PHQ9',preScore:1,postScore:1,note:'수정 불가',preDate:today,postDate:today,notCompletedReason:'',programId:'PRG-C1',runId:'RUN-C1-A'},cookie)).status,400);
    assert.deepEqual({...db.prepare('SELECT * FROM assessment_scores WHERE application_id=101').get()},historyBefore);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,auditBefore);
    for(const action of [{action:'assignRun',applicationId:101,runId:'RUN-C1-B'},{action:'applyToRun',participantId:'P-C1-H',runId:'RUN-C1-B'},{action:'apply',participantId:'P-C1-H',programId:'PRG-C1'}])assert.equal((await post(action,cookie)).status,400);
    assert.equal(db.prepare('SELECT run_id,status FROM applications WHERE id=101').get().run_id,'RUN-C1-A');assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,auditBefore);
    assert.equal((await post({action:'assignRun',applicationId:102,runId:'RUN-C1-A'},cookie)).status,200);assert.equal(db.prepare('SELECT run_id FROM applications WHERE id=102').get().run_id,'RUN-C1-A');
    const mergeAuditBefore=db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='병합'").get().count;
    assert.equal((await post({action:'mergeParticipants',keepId:'P-C1-K',mergeId:'P-C1-S'},cookie)).status,400);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants WHERE id IN (?,?)').get('P-C1-K','P-C1-S').count,2);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM assessment_scores WHERE application_id=104').get().count,1);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='병합'").get().count,mergeAuditBefore);
    assert.equal((await post({action:'mergeParticipants',keepId:'P-C1-SK',mergeId:'P-C1-SS'},cookie)).status,200);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants WHERE id=?').get('P-C1-SS').count,0);
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});