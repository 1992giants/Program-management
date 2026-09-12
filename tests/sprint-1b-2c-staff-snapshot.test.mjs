import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('역할별 login, GET, mutation snapshot은 서버 경계에서 필요한 필드만 반환한다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-staff-snapshot-'));
  const databasePath=path.join(directory,'snapshot-test.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-12';
    const users=[
      ['USR-SNAPSHOT-ADMIN','snapshot-admin','스냅샷 관리자','86420975','관리자'],
      ['USR-SNAPSHOT-STAFF','snapshot-staff','스냅샷 담당자','75310864','일반 담당자'],
      ['USR-SNAPSHOT-ATTENDANCE','snapshot-attendance','출석 담당자','24681357','출석 입력 전용'],
    ];
    for(const [id,username,displayName,pin,role] of users)db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run(id,username,displayName,hashPin(username,pin),role,today);
    db.prepare("INSERT OR REPLACE INTO settings (key,value) VALUES ('internal_snapshot_secret','do-not-send-setting')").run();
    db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-SNAPSHOT-1','김운영','여성',41,'010-1234-5678','회원','참가자 메모',?)").run(today);
    db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-SNAPSHOT-2','김운영','남성',39,'010-1234-5678','비회원','중복 참가자 메모',?)").run(today);
    db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-DUPLICATE-1','중복 확인','미입력',0,'010-9999-9999','비회원','',?)").run(today);
    db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-DUPLICATE-2','중복 확인','미입력',0,'010-9999-9999','비회원','',?)").run(today);
    db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES ('PRG-SNAPSHOT','회복 프로그램','회복','집단',1,'매주','센터','담당자',10,'운영 중',?)").run(today);
    db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES ('RUN-SNAPSHOT','PRG-SNAPSHOT',3,'3차',?,'진행 중')").run(today);
    db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location,reopen_reason) VALUES ('SESSION-SNAPSHOT','RUN-SNAPSHOT',1,?,'10:00','센터','관리자 전용 재개 사유')").run(today);
    db.prepare("INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number,status_reason,status_updated_at,assigned_at) VALUES (501,'P-SNAPSHOT-1','PRG-SNAPSHOT','RUN-SNAPSHOT',?,'참가중',2,'신청 사유',?,?)").run(today,today,today);
    db.prepare("INSERT INTO attendance (application_id,session_id,status,note) VALUES (501,'SESSION-SNAPSHOT','참석','출석 상세')").run();
    db.prepare("INSERT INTO certificates (participant_id,issued_at,session_count) VALUES ('P-SNAPSHOT-1',?,1)").run(today);
    db.prepare("INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at) VALUES (501,'ASM-PHQ9',9,4,'검사 메모',?)").run(today);
    db.prepare("INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at) VALUES (501,5,'만족도 의견',?)").run(today);
    db.prepare("INSERT INTO schedule_events (id,event_type,color,participant_id,title,event_date,created_at) VALUES ('EVENT-SNAPSHOT','상담','green','P-SNAPSHOT-1','상담 일정',?,?)").run(today,today);

    const post=(body,cookie)=>POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)}));
    const get=cookie=>GET(new Request(origin+'/api/data',{headers:{Cookie:cookie}}));
    const login=async(username,pin)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}};
    const assertStaffBoundary=body=>{
      assert.equal(body.currentUser.role,'일반 담당자');
      assert.deepEqual(Object.keys(body.settings),['center_name']);
      for(const key of ['application_id','database_environment','internal_snapshot_secret','manager_name'])assert.equal(Object.hasOwn(body.settings,key),false,key);
      assert.equal(Object.hasOwn(body.operationalMetrics,'lockedUsers'),false);
      assert.equal(Object.hasOwn(body.operationalMetrics,'latestBackup'),false);
      assert.deepEqual(body.backupFiles,[]);
      assert.deepEqual(body.users,[]);
      assert.deepEqual(body.certificates,[]);
      assert.deepEqual(body.duplicateGroups,[]);
      const participant=body.participants.find(item=>item.id==='P-SNAPSHOT-1');
      for(const key of ['id','name','phone','note','gender','age','member_status','application_count','attended_count'])assert.equal(Object.hasOwn(participant,key),true,key);
      for(const key of ['created_at','last_visit'])assert.equal(Object.hasOwn(participant,key),false,key);
      const application=body.applications.find(item=>item.id===501);
      for(const key of ['id','participant_id','program_id','run_id','applied_at','status','queue_number','status_reason','participant_name','phone','gender','age','member_status','program_name','run_label','delivery_type','session_count','start_date'])assert.equal(Object.hasOwn(application,key),true,key);
      for(const key of ['status_updated_at','assigned_at','round_number'])assert.equal(Object.hasOwn(application,key),false,key);
      const serialized=JSON.stringify(body);
      assert.equal(serialized.includes('do-not-send-setting'),false);
      assert.equal(serialized.includes(process.env.ONMAEUM_TEST_DB_PATH),false);
    };

    const staffLogin=await login('snapshot-staff','75310864');
    assertStaffBoundary(staffLogin.body);
    const staffGet=await get(staffLogin.cookie);
    assert.equal(staffGet.status,200);
    assertStaffBoundary(await staffGet.json());

    const updated=await post({action:'updateParticipant',id:'P-SNAPSHOT-1',name:'김운영 수정',gender:'여성',age:41,phone:'010-1234-5678',memberStatus:'회원',note:'참가자 메모'},staffLogin.cookie);
    assert.equal(updated.status,200);
    const updatedBody=await updated.json();
    assertStaffBoundary(updatedBody);
    const updatedParticipant=updatedBody.participants.find(item=>item.id==='P-SNAPSHOT-1');
    assert.deepEqual({name:updatedParticipant.name,phone:updatedParticipant.phone,gender:updatedParticipant.gender,age:updatedParticipant.age,member_status:updatedParticipant.member_status,note:updatedParticipant.note},{name:'김운영 수정',phone:'010-1234-5678',gender:'여성',age:41,member_status:'회원',note:'참가자 메모'});
    assert.deepEqual({...db.prepare('SELECT name,phone,gender,age,member_status,note FROM participants WHERE id=?').get('P-SNAPSHOT-1')},{name:'김운영 수정',phone:'010-1234-5678',gender:'여성',age:41,member_status:'회원',note:'참가자 메모'});

    const statusChange=await post({action:'applicationStatus',id:501,status:'참가완료',reason:''},staffLogin.cookie);
    assert.equal(statusChange.status,200);
    assertStaffBoundary(await statusChange.json());

    const attendanceLogin=await login('snapshot-attendance','24681357');
    assert.equal(attendanceLogin.body.currentUser.role,'출석 입력 전용');
    assert.equal(attendanceLogin.body.sessions.length,1);
    assert.equal(Object.hasOwn(attendanceLogin.body.sessions[0],'reopen_reason'),false);
    const attendanceGet=await get(attendanceLogin.cookie);
    assert.equal(attendanceGet.status,200);
    assert.equal(Object.hasOwn((await attendanceGet.json()).sessions[0],'reopen_reason'),false);

    const assertAdminBoundary=body=>{
      assert.equal(body.currentUser.role,'관리자');
      assert.equal(body.settings.application_id,'onmaeum-program-care');
      assert.equal(body.settings.database_environment,'test');
      assert.equal(Object.hasOwn(body.operationalMetrics,'lockedUsers'),true);
      assert.equal(Object.hasOwn(body.operationalMetrics,'latestBackup'),true);
      assert.equal(body.duplicateGroups.length,1);
      assert.equal(body.certificates.length,1);
      assert.equal(body.users.some(user=>user.id==='USR-SNAPSHOT-STAFF'),true);
    };
    const adminLogin=await login('snapshot-admin','86420975');
    assertAdminBoundary(adminLogin.body);
    const adminGet=await get(adminLogin.cookie);
    assert.equal(adminGet.status,200);
    assertAdminBoundary(await adminGet.json());
    console.log(JSON.stringify({ok:true}));
  `;
  try {
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{
      cwd:projectRoot,
      env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},
      encoding:'utf8',
    });
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  } finally {rmSync(directory,{recursive:true,force:true});}
});
