import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { isAttendanceDetailReady, isAttendanceResponseCurrent } from '../lib/attendance-state.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('staff 출석 민감정보는 선택한 회기에서만 조회되고 mutation 무결성이 유지된다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-attendance-scope-'));
  const databasePath=path.join(directory,'attendance.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-13';
    const users=[
      ['USR-ATT-ADMIN','att-admin','출석 관리자','86420975','관리자',0],
      ['USR-ATT-STAFF','att-staff','일반 담당자','75310864','일반 담당자',0],
      ['USR-ATT-ONLY','att-only','출석 담당자','24681357','출석 입력 전용',0],
      ['USR-ATT-TEMP','att-temp','임시 담당자','13572468','일반 담당자',1],
    ];
    for(const row of users)db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?)').run(row[0],row[1],row[2],hashPin(row[1],row[3]),row[4],today,row[5]);
    for(const row of [
      ['P-ATT-A','참가자 A'],['P-ATT-B','참가자 B'],['P-ATT-C','취소 참가자'],['P-ATT-W','중도탈락 참가자'],['P-ATT-X','프로그램 불일치 참가자']
    ])db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'미입력',0,'010-0000-0000','비회원','',?)").run(row[0],row[1],today);
    for(const row of [['PRG-ATT-A','출석 프로그램 A'],['PRG-ATT-B','출석 프로그램 B']])db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,'회복','집단',3,'매주','센터','담당자',10,'운영 중',?)").run(row[0],row[1],today);
    for(const row of [['RUN-ATT-A','PRG-ATT-A',1,'A 1차'],['RUN-ATT-B','PRG-ATT-B',1,'B 1차']])db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,'진행 중')").run(row[0],row[1],row[2],row[3],today);
    for(const row of [
      ['SESSION-ATT-A1','RUN-ATT-A',1,'작성 중'],
      ['SESSION-ATT-A2','RUN-ATT-A',2,'작성 중'],
      ['SESSION-ATT-A-CLOSED','RUN-ATT-A',3,'마감'],
      ['SESSION-ATT-B1','RUN-ATT-B',1,'작성 중'],
    ])db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location,attendance_status) VALUES (?,?,?,?,?,'센터',?)").run(row[0],row[1],row[2],today,'10:00',row[3]);
    const applications=[
      [701,'P-ATT-A','PRG-ATT-A','RUN-ATT-A','참가중'],
      [702,'P-ATT-B','PRG-ATT-B','RUN-ATT-B','참가중'],
      [703,'P-ATT-C','PRG-ATT-A','RUN-ATT-A','취소'],
      [704,'P-ATT-W','PRG-ATT-A','RUN-ATT-A','중도탈락'],
      [705,'P-ATT-X','PRG-ATT-B','RUN-ATT-A','참가중'],
    ];
    for(const row of applications)db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (?,?,?,?,?,?,?)').run(row[0],row[1],row[2],row[3],today,row[4],row[0]-700);
    const attendanceRows=[
      [701,'SESSION-ATT-A1','참석','ATTENDANCE_NOTE_A_SENTINEL','2099-01-01T01:02:03.000Z','MAKEUP_PRIVATE_SENTINEL'],
      [701,'SESSION-ATT-A2','결석','ATTENDANCE_NOTE_A2_SENTINEL','2099-01-02T01:02:03.000Z',null],
      [701,'SESSION-ATT-A-CLOSED','참석','ATTENDANCE_CLOSED_SENTINEL',null,null],
      [702,'SESSION-ATT-B1','참석','ATTENDANCE_NOTE_B_SENTINEL','2099-02-01T01:02:03.000Z',null],
      [702,'SESSION-ATT-A1','참석','ATTENDANCE_INCONSISTENT_SENTINEL',null,null],
      [703,'SESSION-ATT-A1','참석','ATTENDANCE_CANCELLED_SENTINEL',null,null],
      [704,'SESSION-ATT-A1','참석','ATTENDANCE_WITHDRAWN_SENTINEL',null,null],
      [705,'SESSION-ATT-A1','참석','CROSS_PROGRAM_NOTE_SENTINEL',null,null],
    ];
    for(const row of attendanceRows)db.prepare('INSERT INTO attendance (application_id,session_id,status,note,contacted_at,makeup_for_session_id) VALUES (?,?,?,?,?,?)').run(...row);

    const request=(method,url,cookie,body)=>new Request(origin+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const get=(url,cookie)=>GET(request('GET',url,cookie));
    const post=(body,cookie)=>POST(request('POST','/api/data',cookie,body));
    const login=async(username,pin)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}};
    const secrets=['ATTENDANCE_NOTE_A_SENTINEL','2099-01-01T01:02:03.000Z','MAKEUP_PRIVATE_SENTINEL','ATTENDANCE_NOTE_A2_SENTINEL','2099-01-02T01:02:03.000Z','ATTENDANCE_CLOSED_SENTINEL','ATTENDANCE_NOTE_B_SENTINEL','2099-02-01T01:02:03.000Z','ATTENDANCE_INCONSISTENT_SENTINEL','ATTENDANCE_CANCELLED_SENTINEL','ATTENDANCE_WITHDRAWN_SENTINEL','CROSS_PROGRAM_NOTE_SENTINEL','SAVE_NOTE_SENTINEL'];
    const assertStaffSummary=body=>{
      assert.equal(body.currentUser.role,'일반 담당자');
      assert.ok(body.attendance.length>=4);
      assert.deepEqual(Object.keys(body.attendance[0]).sort(),['application_id','id','participant_id','program_name','run_id','run_label','session_date','session_id','session_number','status']);
      assert.equal(Object.hasOwn(body.sessions[0],'reopen_reason'),false);
      const serialized=JSON.stringify(body);
      for(const secret of secrets)assert.equal(serialized.includes(secret),false,secret);
    };

    const staff=await login('att-staff','75310864');assertStaffSummary(staff.body);
    const staffGet=await get('/api/data',staff.cookie);assert.equal(staffGet.status,200);assertStaffSummary(await staffGet.json());
    const admin=await login('att-admin','86420975');assert.ok(JSON.stringify(admin.body).includes('ATTENDANCE_NOTE_A_SENTINEL'));assert.ok(Object.hasOwn(admin.body.sessions[0],'reopen_reason'));
    const attendanceOnly=await login('att-only','24681357');assert.ok(JSON.stringify(attendanceOnly.body).includes('ATTENDANCE_NOTE_A_SENTINEL'));
    const temporary=await login('att-temp','13572468');

    const detailResponse=await get('/api/data?resource=attendance&sessionId=SESSION-ATT-A1',staff.cookie);
    assert.equal(detailResponse.status,200);assert.equal(detailResponse.headers.get('cache-control'),'no-store');
    const detail=await detailResponse.json();assert.equal(detail.sessionId,'SESSION-ATT-A1');assert.equal(detail.runId,'RUN-ATT-A');
    assert.deepEqual(detail.attendance.map(row=>row.application_id),[701]);
    assert.deepEqual(Object.keys(detail.attendance[0]).sort(),['application_id','contacted_at','id','makeup_for_session_id','note','session_id','status']);
    assert.ok(JSON.stringify(detail).includes('ATTENDANCE_NOTE_A_SENTINEL'));
    for(const secret of ['ATTENDANCE_NOTE_A2_SENTINEL','ATTENDANCE_NOTE_B_SENTINEL','ATTENDANCE_INCONSISTENT_SENTINEL','ATTENDANCE_CANCELLED_SENTINEL','ATTENDANCE_WITHDRAWN_SENTINEL','CROSS_PROGRAM_NOTE_SENTINEL'])assert.equal(JSON.stringify(detail).includes(secret),false);
    const expanded=await get('/api/data?resource=attendance&sessionId=SESSION-ATT-A1&includeAll=true&fields=*',staff.cookie);assert.equal(expanded.status,200);assert.deepEqual(Object.keys((await expanded.json()).attendance[0]).sort(),['application_id','contacted_at','id','makeup_for_session_id','note','session_id','status']);
    const closedRead=await get('/api/data?resource=attendance&sessionId=SESSION-ATT-A-CLOSED',staff.cookie);assert.equal(closedRead.status,200);assert.ok(JSON.stringify(await closedRead.json()).includes('ATTENDANCE_CLOSED_SENTINEL'));

    const invalidUrls=[
      '/api/data?resource=attendance',
      '/api/data?resource=attendance&sessionId=',
      '/api/data?resource=attendance&sessionId=%20%20',
      '/api/data?resource=attendance&sessionId=*',
      '/api/data?resource=attendance&sessionId=%25',
      '/api/data?resource=attendance&sessionId=_',
      '/api/data?resource=attendance&sessionId=SESSION-ATT-A1&sessionId=SESSION-ATT-A2',
      '/api/data?resource=attendance&sessionId=SESSION-NOT-FOUND',
    ];
    for(const url of invalidUrls){const response=await get(url,staff.cookie);assert.ok(response.status>=400&&response.status<500,url);assert.equal(response.headers.get('cache-control'),'no-store');const serialized=JSON.stringify(await response.json());for(const secret of secrets)assert.equal(serialized.includes(secret),false,url)}
    assert.equal((await get('/api/data?resource=attendance&sessionId=SESSION-ATT-A1')).status,401);
    assert.equal((await get('/api/data?resource=attendance&sessionId=SESSION-ATT-A1',attendanceOnly.cookie)).status,403);
    assert.equal((await get('/api/data?resource=attendance&sessionId=SESSION-ATT-A1',temporary.cookie)).status,403);
    assert.equal((await get('/api/data?resource=attendance&sessionId=SESSION-ATT-A1',admin.cookie)).status,200);

    const auditCount=()=>db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    const attendanceState=(applicationId,sessionId)=>JSON.stringify(db.prepare('SELECT * FROM attendance WHERE application_id=? AND session_id=?').get(applicationId,sessionId)||null);
    let beforeAudit=auditCount(),before=attendanceState(703,'SESSION-ATT-A1');
    let denied=await post({action:'attendance',applicationId:703,sessionId:'SESSION-ATT-A1',status:'참석',note:'CANCELLED_WRITE'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(703,'SESSION-ATT-A1'),before);assert.equal(auditCount(),beforeAudit);
    before=attendanceState(701,'SESSION-ATT-A1');denied=await post({action:'attendanceBulk',applicationIds:[701,704],sessionId:'SESSION-ATT-A1',status:'참석'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(701,'SESSION-ATT-A1'),before);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'attendance',applicationId:702,sessionId:'SESSION-ATT-A1',status:'참석',note:''},staff.cookie);assert.equal(denied.status,400);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'attendanceBulk',applicationIds:[701,702],sessionId:'SESSION-ATT-A1',status:'참석'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(701,'SESSION-ATT-A1'),before);assert.equal(auditCount(),beforeAudit);
    const crossProgramExisting=attendanceState(705,'SESSION-ATT-A1'),crossProgramMissing=attendanceState(705,'SESSION-ATT-A2');
    denied=await post({action:'attendance',applicationId:705,sessionId:'SESSION-ATT-A1',status:'참석',note:'CROSS_PROGRAM_SINGLE_WRITE'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(705,'SESSION-ATT-A1'),crossProgramExisting);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'attendance',applicationId:705,sessionId:'SESSION-ATT-A2',status:'참석',note:'CROSS_PROGRAM_SINGLE_INSERT'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(705,'SESSION-ATT-A2'),crossProgramMissing);assert.equal(auditCount(),beforeAudit);
    const validBeforeBulk=attendanceState(701,'SESSION-ATT-A2');
    denied=await post({action:'attendanceBulk',applicationIds:[701,705],sessionId:'SESSION-ATT-A2',status:'참석'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(701,'SESSION-ATT-A2'),validBeforeBulk);assert.equal(attendanceState(705,'SESSION-ATT-A2'),crossProgramMissing);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'attendance',applicationId:701,sessionId:'SESSION-ATT-A1',status:'보강',note:'MAKEUP_INVALID',makeupForSessionId:'SESSION-NOT-FOUND'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(701,'SESSION-ATT-A1'),before);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'attendance',applicationId:701,sessionId:'SESSION-ATT-A1',status:'보강',note:'MAKEUP_CROSS_RUN',makeupForSessionId:'SESSION-ATT-B1'},staff.cookie);assert.equal(denied.status,400);assert.equal(attendanceState(701,'SESSION-ATT-A1'),before);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'attendance',applicationId:701,sessionId:'SESSION-ATT-A-CLOSED',status:'참석',note:''},staff.cookie);assert.equal(denied.status,400);assert.equal(auditCount(),beforeAudit);
    denied=await post({action:'attendanceBulk',applicationIds:[701],sessionId:'SESSION-ATT-A-CLOSED',status:'참석'},staff.cookie);assert.equal(denied.status,400);assert.equal(auditCount(),beforeAudit);

    const participantMutation=await post({action:'updateParticipant',id:'P-ATT-A',name:'참가자 A',gender:'미입력',age:0,phone:'010-0000-0000',memberStatus:'비회원',note:''},staff.cookie);assert.equal(participantMutation.status,200);assertStaffSummary(await participantMutation.json());
    const applicationMutation=await post({action:'applicationStatus',id:701,status:'참가중',reason:''},staff.cookie);assert.equal(applicationMutation.status,200);assertStaffSummary(await applicationMutation.json());
    const save=await post({action:'attendance',applicationId:701,sessionId:'SESSION-ATT-A1',status:'보강',note:'SAVE_NOTE_SENTINEL',contactedAt:'2026-09-13T10:00:00.000Z',makeupForSessionId:'SESSION-ATT-A2'},staff.cookie);assert.equal(save.status,200);assertStaffSummary(await save.json());
    assert.deepEqual({...db.prepare('SELECT status,note,makeup_for_session_id FROM attendance WHERE application_id=701 AND session_id=?').get('SESSION-ATT-A1')},{status:'보강',note:'SAVE_NOTE_SENTINEL',makeup_for_session_id:'SESSION-ATT-A2'});
    const bulk=await post({action:'attendanceBulk',applicationIds:[701],sessionId:'SESSION-ATT-A2',status:'참석'},staff.cookie);assert.equal(bulk.status,200);assertStaffSummary(await bulk.json());
    const close=await post({action:'closeAttendanceSession',sessionId:'SESSION-ATT-A2'},staff.cookie);assert.equal(close.status,200);assertStaffSummary(await close.json());assert.equal(db.prepare('SELECT attendance_status FROM sessions WHERE id=?').get('SESSION-ATT-A2').attendance_status,'마감');
    const attendanceOnlyRegression=await post({action:'attendanceBulk',applicationIds:[702],sessionId:'SESSION-ATT-B1',status:'참석'},attendanceOnly.cookie);assert.equal(attendanceOnlyRegression.status,200);
    const auditSerialized=JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());for(const secret of ['SAVE_NOTE_SENTINEL','CANCELLED_WRITE','MAKEUP_INVALID','MAKEUP_CROSS_RUN'])assert.equal(auditSerialized.includes(secret),false,secret);
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('staff 출석 UI는 freshness와 canonical scope가 확인된 경우에만 편집한다',()=>{
  assert.equal(isAttendanceDetailReady(true,true,false,true,''),true);
  assert.equal(isAttendanceDetailReady(true,true,true,false,''),false);
  assert.equal(isAttendanceDetailReady(true,true,false,false,'authoritative reload failed'),false);
  assert.equal(isAttendanceDetailReady(false,false,true,false,'admin uses snapshot'),true);
  assert.equal(isAttendanceResponseCurrent('SESSION-B','RUN-B','SESSION-A','RUN-A','SESSION-A','RUN-A'),false);
  assert.equal(isAttendanceResponseCurrent('SESSION-B','RUN-B','SESSION-B','RUN-B','SESSION-A','RUN-A'),false);
  assert.equal(isAttendanceResponseCurrent('SESSION-B','RUN-B','SESSION-B','RUN-B','SESSION-B','RUN-B'),true);
  const page=readFileSync(path.join(projectRoot,'app/page.tsx'),'utf8');
  const attendance=page.slice(page.indexOf('function AttendanceV2'),page.indexOf('function AttendanceRowEditor'));
  assert.match(attendance,/resource=attendance&sessionId=/);
  assert.match(attendance,/attendanceAbort\.current\?\.abort\(\)/);
  assert.match(attendance,/setAttendanceFresh\(false\)/);
  assert.match(attendance,/setAttendanceFresh\(true\)/);
  assert.match(attendance,/isAttendanceResponseCurrent/);
  assert.match(attendance,/isAttendanceDetailReady/);
  assert.match(attendance,/await loadSessionAttendance\(targetSessionId,targetRunId,true\)/);
  assert.doesNotMatch(page,/(localStorage|sessionStorage|indexedDB).*attendance/i);
});
