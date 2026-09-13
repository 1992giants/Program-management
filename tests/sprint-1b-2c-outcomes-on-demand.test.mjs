import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isOutcomeEditorEnabled } from '../lib/outcomes-state.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('staff 성과 원자료는 선택한 프로그램 또는 차수 범위에서만 조회·저장된다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-outcomes-scope-'));
  const databasePath=path.join(directory,'outcomes.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-12';
    const users=[
      ['USR-OUTCOME-ADMIN','outcome-admin','성과 관리자','86420975','관리자',0],
      ['USR-OUTCOME-STAFF','outcome-staff','성과 담당자','75310864','일반 담당자',0],
      ['USR-OUTCOME-ATTENDANCE','outcome-attendance','출석 담당자','24681357','출석 입력 전용',0],
      ['USR-OUTCOME-TEMP','outcome-temp','임시 담당자','13572468','일반 담당자',1],
    ];
    for(const [id,username,displayName,pin,role,mustChangePin] of users)db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?)').run(id,username,displayName,hashPin(username,pin),role,today,mustChangePin);
    for(const [id,name] of [['P-OUT-A1','참가자 A1'],['P-OUT-A2','참가자 A2'],['P-OUT-A0','참가자 A 미배정'],['P-OUT-B1','참가자 B1'],['P-OUT-X','불일치 참가자'],['P-OUT-C','취소 참가자'],['P-OUT-W','중도탈락 참가자']])db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'미입력',0,'010-0000-0000','비회원','',?)").run(id,name,today);
    for(const [id,name] of [['PRG-OUT-A','성과 프로그램 A'],['PRG-OUT-B','성과 프로그램 B']])db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,'회복','집단',1,'매주','센터','담당자',10,'운영 중',?)").run(id,name,today);
    for(const row of [['RUN-OUT-A1','PRG-OUT-A',1,'A 1차'],['RUN-OUT-A2','PRG-OUT-A',2,'A 2차'],['RUN-OUT-B1','PRG-OUT-B',1,'B 1차']])db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,'진행 중')").run(...row,today);
    const applications=[
      [601,'P-OUT-A1','PRG-OUT-A','RUN-OUT-A1'],
      [602,'P-OUT-A2','PRG-OUT-A','RUN-OUT-A2'],
      [603,'P-OUT-A0','PRG-OUT-A',null],
      [604,'P-OUT-B1','PRG-OUT-B','RUN-OUT-B1'],
      [605,'P-OUT-X','PRG-OUT-A','RUN-OUT-B1'],
      [606,'P-OUT-C','PRG-OUT-A','RUN-OUT-A1'],
      [607,'P-OUT-W','PRG-OUT-A','RUN-OUT-A1'],
    ];
    for(const row of applications)db.prepare("INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (?,?,?,?,?,'참가중',?)").run(...row,today,row[0]-600);
    db.prepare("UPDATE applications SET status='취소' WHERE id=606").run();
    db.prepare("UPDATE applications SET status='중도탈락' WHERE id=607").run();
    db.prepare('INSERT INTO program_assessments (program_id,assessment_id,sort_order) VALUES (?,?,0)').run('PRG-OUT-A','ASM-PHQ9');
    db.prepare('INSERT INTO program_assessments (program_id,assessment_id,sort_order) VALUES (?,?,0)').run('PRG-OUT-B','ASM-GAD7');
    const records=[
      [601,'ASM-PHQ9',26.123456,7,'OUTCOME-A1-NOTE','OUTCOME-A1-REASON'],
      [602,'ASM-PHQ9',12,8,'OUTCOME-A2-NOTE','OUTCOME-A2-REASON'],
      [603,'ASM-PHQ9',13,9,'OUTCOME-A0-NOTE','OUTCOME-A0-REASON'],
      [604,'ASM-GAD7',14,10,'OUTCOME-B1-NOTE','OUTCOME-B1-REASON'],
      [605,'ASM-PHQ9',15,11,'OUTCOME-INCONSISTENT-NOTE','OUTCOME-INCONSISTENT-REASON'],
      [606,'ASM-PHQ9',16,12,'OUTCOME-CANCELLED-NOTE','OUTCOME-CANCELLED-REASON'],
      [607,'ASM-PHQ9',17,13,'OUTCOME-WITHDRAWN-NOTE','OUTCOME-WITHDRAWN-REASON'],
    ];
    for(const row of records)db.prepare('INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at,not_completed_reason) VALUES (?,?,?,?,?,?,?)').run(row[0],row[1],row[2],row[3],row[4],today,row[5]);
    for(const [applicationId,score,comment] of [[601,5,'SAT-A1-COMMENT'],[602,4,'SAT-A2-COMMENT'],[603,3,'SAT-A0-COMMENT'],[604,2,'SAT-B1-COMMENT'],[605,1,'SAT-INCONSISTENT-COMMENT'],[606,1,'SAT-CANCELLED-COMMENT'],[607,1,'SAT-WITHDRAWN-COMMENT']])db.prepare('INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at) VALUES (?,?,?,?)').run(applicationId,score,comment,today);

    const request=(method,url,cookie,body)=>new Request(origin+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const get=(url,cookie)=>GET(request('GET',url,cookie));
    const post=(body,cookie)=>POST(request('POST','/api/data',cookie,body));
    const login=async(username,pin)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}};
    const sentinels=records.flatMap(row=>[row[4],row[5]]).concat(['26.123456','SAT-A1-COMMENT','SAT-A2-COMMENT','SAT-A0-COMMENT','SAT-B1-COMMENT','SAT-INCONSISTENT-COMMENT','SAT-CANCELLED-COMMENT','SAT-WITHDRAWN-COMMENT']);
    const assertNoBulkOutcomes=body=>{assert.deepEqual(body.assessmentScores,[]);assert.deepEqual(body.satisfactionSurveys,[]);assert.ok(body.assessmentCatalog.length>=3);assert.equal(body.programAssessments.length,2);const serialized=JSON.stringify(body);for(const sentinel of sentinels)assert.equal(serialized.includes(sentinel),false,sentinel)};

    const staff=await login('outcome-staff','75310864');
    assertNoBulkOutcomes(staff.body);
    const staffGet=await get('/api/data',staff.cookie);assert.equal(staffGet.status,200);assertNoBulkOutcomes(await staffGet.json());
    const mutation=await post({action:'setAssessmentActive',id:'ASM-PSS10',active:false},staff.cookie);assert.equal(mutation.status,200);assertNoBulkOutcomes(await mutation.json());
    const participantMutation=await post({action:'updateParticipant',id:'P-OUT-A1',name:'참가자 A1',gender:'미입력',age:0,phone:'010-0000-0000',memberStatus:'비회원',note:''},staff.cookie);assert.equal(participantMutation.status,200);assertNoBulkOutcomes(await participantMutation.json());
    const applicationMutation=await post({action:'applicationStatus',id:602,status:'참가대기',reason:''},staff.cookie);assert.equal(applicationMutation.status,200);assertNoBulkOutcomes(await applicationMutation.json());

    const admin=await login('outcome-admin','86420975');
    assert.equal(admin.body.assessmentScores.length,7);assert.equal(admin.body.satisfactionSurveys.length,7);assert.ok(JSON.stringify(admin.body).includes('OUTCOME-B1-NOTE'));

    const programResponse=await get('/api/data?resource=outcomes&programId=PRG-OUT-A',staff.cookie);assert.equal(programResponse.status,200);assert.equal(programResponse.headers.get('cache-control'),'no-store');
    const programBody=await programResponse.json();assert.equal(programBody.programId,'PRG-OUT-A');assert.equal(programBody.runId,null);
    assert.deepEqual(programBody.assessmentScores.map(row=>row.application_id),[601,602,603]);assert.deepEqual(programBody.satisfactionSurveys.map(row=>row.application_id),[601,602,603]);
    assert.deepEqual(Object.keys(programBody.assessmentScores[0]).sort(),['application_id','assessment_id','not_completed_reason','note','post_date','post_score','pre_date','pre_score']);
    assert.deepEqual(Object.keys(programBody.satisfactionSurveys[0]).sort(),['anonymous','application_id','comment','score','survey_version']);
    const programSerialized=JSON.stringify(programBody);assert.equal(programSerialized.includes('OUTCOME-B1-NOTE'),false);assert.equal(programSerialized.includes('OUTCOME-INCONSISTENT-NOTE'),false);assert.equal(programSerialized.includes('OUTCOME-CANCELLED-NOTE'),false);assert.equal(programSerialized.includes('OUTCOME-WITHDRAWN-NOTE'),false);assert.ok(programSerialized.includes('OUTCOME-A0-NOTE'));

    const runResponse=await get('/api/data?resource=outcomes&programId=PRG-OUT-A&runId=RUN-OUT-A1',staff.cookie);assert.equal(runResponse.status,200);
    const runBody=await runResponse.json();assert.equal(runBody.programId,'PRG-OUT-A');assert.equal(runBody.runId,'RUN-OUT-A1');assert.deepEqual(runBody.assessmentScores.map(row=>row.application_id),[601]);assert.deepEqual(runBody.satisfactionSurveys.map(row=>row.application_id),[601]);
    const runBBody=await (await get('/api/data?resource=outcomes&programId=PRG-OUT-B&runId=RUN-OUT-B1',staff.cookie)).json();assert.deepEqual(runBBody.assessmentScores.map(row=>row.application_id),[604]);assert.deepEqual(runBBody.satisfactionSurveys.map(row=>row.application_id),[604]);
    const expanded=await get('/api/data?resource=outcomes&programId=PRG-OUT-A&runId=RUN-OUT-A1&include=all',staff.cookie);assert.equal(expanded.status,200);assert.deepEqual((await expanded.json()).assessmentScores.map(row=>row.application_id),[601]);

    const invalidUrls=[
      '/api/data?resource=outcomes',
      '/api/data?resource=outcomes&programId=',
      '/api/data?resource=outcomes&programId=*',
      '/api/data?resource=outcomes&programId=PRG-OUT-A&programId=PRG-OUT-B',
      '/api/data?resource=outcomes&programId=PRG-NOT-FOUND',
      '/api/data?resource=outcomes&programId=PRG-OUT-A&runId=',
      '/api/data?resource=outcomes&programId=PRG-OUT-A&runId=*',
      '/api/data?resource=outcomes&programId=PRG-OUT-A&runId=RUN-OUT-A1&runId=RUN-OUT-A2',
      '/api/data?resource=outcomes&programId=PRG-OUT-A&runId=RUN-NOT-FOUND',
      '/api/data?resource=outcomes&programId=PRG-OUT-A&runId=RUN-OUT-B1',
    ];
    for(const url of invalidUrls){const response=await get(url,staff.cookie);assert.ok(response.status>=400&&response.status<500,url);assert.equal(response.headers.get('cache-control'),'no-store');const serialized=JSON.stringify(await response.json());for(const sentinel of sentinels)assert.equal(serialized.includes(sentinel),false,url)}

    assert.equal((await get('/api/data?resource=outcomes&programId=PRG-OUT-A')).status,401);
    const attendance=await login('outcome-attendance','24681357');assert.equal((await get('/api/data?resource=outcomes&programId=PRG-OUT-A',attendance.cookie)).status,403);
    const temporary=await login('outcome-temp','13572468');assert.equal((await get('/api/data?resource=outcomes&programId=PRG-OUT-A',temporary.cookie)).status,403);
    assert.equal((await get('/api/data?resource=outcomes&programId=PRG-OUT-A',admin.cookie)).status,200);

    const auditCount=()=>db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    let beforeAudit=auditCount(),beforeScore={...db.prepare('SELECT * FROM assessment_scores WHERE application_id=? AND assessment_id=?').get(604,'ASM-GAD7')};
    let denied=await post({action:'saveAssessmentScore',applicationId:604,assessmentId:'ASM-GAD7',preScore:1,postScore:2,note:'INJECTED-SCORE',preDate:today,postDate:today,notCompletedReason:'',programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(denied.status,400);assert.deepEqual({...db.prepare('SELECT * FROM assessment_scores WHERE application_id=? AND assessment_id=?').get(604,'ASM-GAD7')},beforeScore);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'saveAssessmentScore',applicationId:602,assessmentId:'ASM-PHQ9',preScore:1,postScore:2,note:'WRONG-RUN',preDate:today,postDate:today,notCompletedReason:'',programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(denied.status,400);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'saveAssessmentScore',applicationId:601,assessmentId:'ASM-GAD7',preScore:1,postScore:2,note:'UNCONFIGURED',preDate:today,postDate:today,notCompletedReason:'',programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(denied.status,400);assert.equal(auditCount(),beforeAudit);
    const beforeSatisfaction={...db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=602').get()};denied=await post({action:'saveSatisfaction',applicationId:602,score:1,comment:'WRONG-SCOPE',surveyVersion:'1.0',anonymous:false,programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(denied.status,400);assert.deepEqual({...db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=602').get()},beforeSatisfaction);assert.equal(auditCount(),beforeAudit);
    const inconsistentScore={...db.prepare('SELECT * FROM assessment_scores WHERE application_id=605').get()},inconsistentSatisfaction={...db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=605').get()};
    denied=await post({action:'saveAssessmentScore',applicationId:605,assessmentId:'ASM-PHQ9',preScore:1,postScore:2,note:'INCONSISTENT-SCORE-WRITE',preDate:today,postDate:today,notCompletedReason:'',programId:'PRG-OUT-A'},staff.cookie);assert.equal(denied.status,400);assert.deepEqual({...db.prepare('SELECT * FROM assessment_scores WHERE application_id=605').get()},inconsistentScore);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'saveSatisfaction',applicationId:605,score:5,comment:'INCONSISTENT-SAT-WRITE',surveyVersion:'1.0',anonymous:false,programId:'PRG-OUT-A'},staff.cookie);assert.equal(denied.status,400);assert.deepEqual({...db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=605').get()},inconsistentSatisfaction);assert.equal(auditCount(),beforeAudit);
    for(const [applicationId,label] of [[606,'CANCELLED'],[607,'WITHDRAWN']]){
      const scoreBefore={...db.prepare('SELECT * FROM assessment_scores WHERE application_id=?').get(applicationId)},satisfactionBefore={...db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=?').get(applicationId)};
      denied=await post({action:'saveAssessmentScore',applicationId,assessmentId:'ASM-PHQ9',preScore:1,postScore:2,note:label+'-SCORE-WRITE',preDate:today,postDate:today,notCompletedReason:'',programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(denied.status,400);assert.deepEqual({...db.prepare('SELECT * FROM assessment_scores WHERE application_id=?').get(applicationId)},scoreBefore);assert.equal(auditCount(),beforeAudit);
      denied=await post({action:'saveSatisfaction',applicationId,score:5,comment:label+'-SAT-WRITE',surveyVersion:'1.0',anonymous:false,programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(denied.status,400);assert.deepEqual({...db.prepare('SELECT * FROM satisfaction_surveys WHERE application_id=?').get(applicationId)},satisfactionBefore);assert.equal(auditCount(),beforeAudit);
    }
    denied=await post({action:'saveAssessmentScore',applicationId:999999,assessmentId:'ASM-PHQ9',preScore:1,postScore:2,note:'MISSING-APPLICATION',preDate:today,postDate:today,notCompletedReason:'',programId:'PRG-OUT-A'},staff.cookie);assert.equal(denied.status,400);assert.equal(auditCount(),beforeAudit);

    const scoreSave=await post({action:'saveAssessmentScore',applicationId:601,assessmentId:'ASM-PHQ9',preScore:26.123456,postScore:6,note:'OUTCOME-A1-NOTE',preDate:today,postDate:today,notCompletedReason:'OUTCOME-A1-REASON',programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(scoreSave.status,200);assertNoBulkOutcomes(await scoreSave.json());
    const satisfactionSave=await post({action:'saveSatisfaction',applicationId:601,score:4,comment:'SAT-A1-COMMENT',surveyVersion:'1.0',anonymous:false,programId:'PRG-OUT-A',runId:'RUN-OUT-A1'},staff.cookie);assert.equal(satisfactionSave.status,200);assertNoBulkOutcomes(await satisfactionSave.json());
    assert.equal((await post({action:'saveAssessmentScore',applicationId:602,assessmentId:'ASM-PHQ9',preScore:12,postScore:7,note:'OUTCOME-A2-NOTE',preDate:today,postDate:today,notCompletedReason:'OUTCOME-A2-REASON',programId:'PRG-OUT-A'},staff.cookie)).status,200);
    assert.equal((await post({action:'saveSatisfaction',applicationId:602,score:4,comment:'SAT-A2-COMMENT',surveyVersion:'1.0',anonymous:false,programId:'PRG-OUT-A'},staff.cookie)).status,200);
    assert.equal((await post({action:'saveAssessmentScore',applicationId:603,assessmentId:'ASM-PHQ9',preScore:13,postScore:8,note:'OUTCOME-A0-NOTE',preDate:today,postDate:today,notCompletedReason:'OUTCOME-A0-REASON',programId:'PRG-OUT-A'},staff.cookie)).status,200);
    assert.equal((await post({action:'saveSatisfaction',applicationId:603,score:3,comment:'SAT-A0-COMMENT',surveyVersion:'1.0',anonymous:false,programId:'PRG-OUT-A'},staff.cookie)).status,200);
    const authoritative=await (await get('/api/data?resource=outcomes&programId=PRG-OUT-A&runId=RUN-OUT-A1',staff.cookie)).json();
    assert.deepEqual(authoritative.assessmentScores[0],{application_id:601,assessment_id:'ASM-PHQ9',pre_score:26.123456,post_score:6,pre_date:today,post_date:today,note:'OUTCOME-A1-NOTE',not_completed_reason:'OUTCOME-A1-REASON'});
    assert.deepEqual(authoritative.satisfactionSurveys[0],{application_id:601,score:4,comment:'SAT-A1-COMMENT',survey_version:'1.0',anonymous:0});
    const programAuthoritative=await (await get('/api/data?resource=outcomes&programId=PRG-OUT-A',staff.cookie)).json();assert.deepEqual(programAuthoritative.assessmentScores.map(row=>row.application_id),[601,602,603]);assert.deepEqual(programAuthoritative.satisfactionSurveys.map(row=>row.application_id),[601,602,603]);
    const auditSerialized=JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());
    for(const secret of ['OUTCOME-A1-NOTE','OUTCOME-A1-REASON','SAT-A1-COMMENT','INJECTED-SCORE','WRONG-RUN','UNCONFIGURED','WRONG-SCOPE','INCONSISTENT-SCORE-WRITE','INCONSISTENT-SAT-WRITE','CANCELLED-SCORE-WRITE','CANCELLED-SAT-WRITE','WITHDRAWN-SCORE-WRITE','WITHDRAWN-SAT-WRITE'])assert.equal(auditSerialized.includes(secret),false,secret);
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('staff 성과 UI는 로딩 완료 전 editor를 열지 않고 stale scope와 저장 후 재조회를 방어한다',()=>{
  let state={scopeMatches:true,loading:false,fresh:true,error:''};
  assert.equal(isOutcomeEditorEnabled(true,state.scopeMatches,state.loading,state.fresh,state.error),true);
  state={...state,loading:true,fresh:false};
  assert.equal(isOutcomeEditorEnabled(true,state.scopeMatches,state.loading,state.fresh,state.error),false);
  state={...state,loading:false,error:'authoritative reload failed'};
  assert.equal(isOutcomeEditorEnabled(true,state.scopeMatches,state.loading,state.fresh,state.error),false);
  state={...state,fresh:true,error:''};
  assert.equal(isOutcomeEditorEnabled(true,state.scopeMatches,state.loading,state.fresh,state.error),true);
  assert.equal(isOutcomeEditorEnabled(false,false,true,false,'ignored for admin'),true);
  const source=readFileSync(path.join(projectRoot,'app','page.tsx'),'utf8');
  const outcomes=source.slice(source.indexOf('function Outcomes('),source.indexOf('function AssessmentConfiguration('));
  assert.match(outcomes,/resource:'outcomes',programId:nextProgramId/);
  assert.match(outcomes,/new AbortController\(\)/);
  assert.match(outcomes,/outcomesAbort\.current\?\.abort\(\)/);
  assert.match(outcomes,/outcomesAbort\.current!==controller/);
  assert.match(outcomes,/current\.programId!==nextProgramId\|\|current\.runId!==nextRunId/);
  assert.match(outcomes,/result\.programId!==nextProgramId\|\|result\.runId!==expectedRunId/);
  assert.match(outcomes,/setOutcomesLoading\(true\);setOutcomesFresh\(false\);setOutcomesError\(''\)/);
  assert.match(outcomes,/setScopedOutcomes\(result\);setOutcomesFresh\(true\)/);
  assert.match(outcomes,/showEditors=isOutcomeEditorEnabled\(isStaff,scopeReady,outcomesLoading,outcomesFresh,outcomesError\)/);
  assert.ok(outcomes.indexOf('await onScore(')<outcomes.indexOf('await loadScopedOutcomes(requested.programId,requested.runId,true)'));
  assert.ok(outcomes.indexOf('await onSatisfaction(')<outcomes.lastIndexOf('await loadScopedOutcomes(requested.programId,requested.runId,true)'));
  assert.match(outcomes,/key=\{isStaff\?`\$\{app\.id\}:\$\{outcomesRevision\}`:app\.id\}/);
  assert.doesNotMatch(source,/(localStorage|sessionStorage|indexedDB).*outcome/i);
});
