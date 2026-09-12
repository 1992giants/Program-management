import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('일반 담당자의 참가자 메모는 초기 snapshot에서 제외되고 단건 상세로만 조회된다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-participant-detail-'));
  const databasePath=path.join(directory,'participant-detail.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-12';
    const users=[
      ['USR-DETAIL-ADMIN','detail-admin','상세 관리자','86420975','관리자',0],
      ['USR-DETAIL-STAFF','detail-staff','상세 담당자','75310864','일반 담당자',0],
      ['USR-DETAIL-ATTENDANCE','detail-attendance','출석 담당자','24681357','출석 입력 전용',0],
      ['USR-DETAIL-TEMP','detail-temp','임시 담당자','13572468','일반 담당자',1],
    ];
    for(const [id,username,displayName,pin,role,mustChangePin] of users)db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?)').run(id,username,displayName,hashPin(username,pin),role,today,mustChangePin);
    db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-DETAIL-A','김상세','여성',42,'010-1111-2222','회원','DETAIL-A-SECRET-NOTE',?)").run(today);
    db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES ('P-DETAIL-B','박단건','남성',37,'010-3333-4444','비회원','DETAIL-B-SECRET-NOTE',?)").run(today);

    const request=(method,url,cookie,body)=>new Request(origin+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const get=(url,cookie)=>GET(request('GET',url,cookie));
    const post=(body,cookie)=>POST(request('POST','/api/data',cookie,body));
    const login=async(username,pin)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}};
    const assertNoStaffNotes=body=>{
      assert.equal(body.currentUser.role,'일반 담당자');
      assert.equal(body.participants.length,2);
      for(const participant of body.participants)assert.equal(Object.hasOwn(participant,'note'),false);
      const serialized=JSON.stringify(body);
      assert.equal(serialized.includes('DETAIL-A-SECRET-NOTE'),false);
      assert.equal(serialized.includes('DETAIL-B-SECRET-NOTE'),false);
    };

    const staff=await login('detail-staff','75310864');
    assertNoStaffNotes(staff.body);
    const staffSnapshot=await get('/api/data',staff.cookie);
    assert.equal(staffSnapshot.status,200);
    assertNoStaffNotes(await staffSnapshot.json());

    const auditBefore=db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count;
    const detailResponse=await get('/api/data?resource=participant&id=P-DETAIL-A',staff.cookie);
    assert.equal(detailResponse.status,200);
    assert.equal(detailResponse.headers.get('cache-control'),'no-store');
    const detailBody=await detailResponse.json();
    assert.deepEqual(Object.keys(detailBody),['participant']);
    assert.deepEqual(Object.keys(detailBody.participant).sort(),['age','gender','id','member_status','name','note','phone']);
    assert.deepEqual(detailBody.participant,{id:'P-DETAIL-A',name:'김상세',phone:'010-1111-2222',gender:'여성',age:42,member_status:'회원',note:'DETAIL-A-SECRET-NOTE'});
    assert.equal(JSON.stringify(detailBody).includes('DETAIL-B-SECRET-NOTE'),false);
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,auditBefore);

    for(const [id,status] of [['',400],['*',404],['%',404],['P-DETAIL-A,P-DETAIL-B',404],['not-a-participant',404]]){
      const response=await get('/api/data?resource=participant&id='+encodeURIComponent(id),staff.cookie);
      assert.equal(response.status,status,id);
      const serialized=JSON.stringify(await response.json());
      assert.equal(serialized.includes('DETAIL-A-SECRET-NOTE'),false,id);
      assert.equal(serialized.includes('DETAIL-B-SECRET-NOTE'),false,id);
    }
    assert.equal(db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,auditBefore);

    const unauthenticated=await get('/api/data?resource=participant&id=P-DETAIL-A');
    assert.equal(unauthenticated.status,401);
    const attendance=await login('detail-attendance','24681357');
    assert.equal((await get('/api/data?resource=participant&id=P-DETAIL-A',attendance.cookie)).status,403);
    const temporary=await login('detail-temp','13572468');
    assert.equal((await get('/api/data?resource=participant&id=P-DETAIL-A',temporary.cookie)).status,403);

    const loaded=detailBody.participant;
    const update=await post({action:'updateParticipant',id:loaded.id,name:'김상세 수정',phone:loaded.phone,gender:loaded.gender,age:loaded.age,memberStatus:loaded.member_status,note:loaded.note},staff.cookie);
    assert.equal(update.status,200);
    const updateBody=await update.json();
    assertNoStaffNotes(updateBody);
    assert.deepEqual({...db.prepare('SELECT name,phone,gender,age,member_status,note FROM participants WHERE id=?').get('P-DETAIL-A')},{name:'김상세 수정',phone:'010-1111-2222',gender:'여성',age:42,member_status:'회원',note:'DETAIL-A-SECRET-NOTE'});

    const access=await post({action:'recordAccess',eventType:'participant_view',targetId:'P-DETAIL-A'},staff.cookie);
    assert.equal(access.status,200);
    const audit=db.prepare('SELECT entity_id,before_json,after_json,summary FROM audit_logs ORDER BY id DESC LIMIT 1').get();
    assert.equal(audit.entity_id,'P-DETAIL-A');
    const auditSerialized=JSON.stringify(audit);
    assert.equal(auditSerialized.includes('DETAIL-A-SECRET-NOTE'),false);
    assert.equal(auditSerialized.includes('010-1111-2222'),false);

    const admin=await login('detail-admin','86420975');
    assert.equal(admin.body.participants.find(item=>item.id==='P-DETAIL-A').note,'DETAIL-A-SECRET-NOTE');
    const adminDetail=await get('/api/data?resource=participant&id=P-DETAIL-A',admin.cookie);
    assert.equal(adminDetail.status,200);
    assert.equal((await adminDetail.json()).participant.note,'DETAIL-A-SECRET-NOTE');
    const adminUpdate=await post({action:'updateParticipant',id:'P-DETAIL-A',name:'김상세 수정',phone:'010-1111-2222',gender:'여성',age:42,memberStatus:'회원',note:'ADMIN-UPDATED-NOTE'},admin.cookie);
    assert.equal(adminUpdate.status,200);
    assert.equal((await adminUpdate.json()).participants.find(item=>item.id==='P-DETAIL-A').note,'ADMIN-UPDATED-NOTE');
    const updatedAdminDetail=await get('/api/data?resource=participant&id=P-DETAIL-A',admin.cookie);
    assert.equal((await updatedAdminDetail.json()).participant.note,'ADMIN-UPDATED-NOTE');
    const updateAudit=JSON.stringify(db.prepare('SELECT before_json,after_json,summary FROM audit_logs ORDER BY id DESC LIMIT 1').get());
    assert.equal(updateAudit.includes('ADMIN-UPDATED-NOTE'),false);
    assert.equal(updateAudit.includes('010-1111-2222'),false);
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

test('참가자 상세 UI는 요청 성공 후에만 모달을 열고 stale 응답을 거부한다',()=>{
  const source=readFileSync(path.join(projectRoot,'app','page.tsx'),'utf8');
  const detailFunction=source.slice(source.indexOf('const openParticipantDetail='),source.indexOf('const loadAuditLogs='));
  assert.match(detailFunction,/resource=participant&id=\$\{encodeURIComponent\(participant\.id\)\}/);
  assert.match(detailFunction,/new AbortController\(\)/);
  assert.match(detailFunction,/participantDetailAbort\.current\?\.abort\(\)/);
  assert.match(detailFunction,/participantDetailAbort\.current!==controller/);
  assert.match(detailFunction,/j\.participant\.id!==participant\.id/);
  assert.ok(detailFunction.indexOf("if(!r.ok||!j.participant)")<detailFunction.indexOf("setModal('editParticipant')"));
  assert.ok(detailFunction.indexOf('j.participant.id!==participant.id')<detailFunction.indexOf("setModal('editParticipant')"));
  assert.doesNotMatch(source,/onEdit=\{p=>\{setEditPerson\(p\);setModal\('editParticipant'\)\}\}/);
  assert.match(source,/selected&&selected\.note!==undefined&&view!=='certificates'/);
  assert.match(source,/function EditParticipantModal\(\{person,onClose,onSubmit\}:\{person:ParticipantDetail;/);
});
