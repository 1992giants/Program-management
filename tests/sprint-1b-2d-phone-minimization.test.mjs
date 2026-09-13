import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('staff bulk 응답은 phone을 제거하고 단건 상세와 exact phone search만 허용한다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-phone-boundary-'));
  const databasePath=path.join(directory,'phone-boundary.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-13',sentinel='010-9876-5432',normalized='01098765432';
    const users=[
      ['USR-PHONE-ADMIN','phone-admin','연락처 관리자','86420975','관리자',0],
      ['USR-PHONE-STAFF','phone-staff','연락처 담당자','75310864','일반 담당자',0],
      ['USR-PHONE-ATTENDANCE','phone-attendance','출석 담당자','24681357','출석 입력 전용',0],
      ['USR-PHONE-TEMP','phone-temp','임시 담당자','13572468','일반 담당자',1],
    ];
    for(const [id,username,displayName,pin,role,mustChangePin] of users)db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?)').run(id,username,displayName,hashPin(username,pin),role,today,mustChangePin);
    for(let index=1;index<=7;index++){const phone=index%2?sentinel:normalized;db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-PHONE-'+index,'동일번호 '+index,'미입력',0,phone,'회원','메모 '+index,today)}
    db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-PHONE-X','다른번호','미입력',0,'010-1111-2222','비회원','다른 메모',today);
    db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('PRG-PHONE','연락처 프로그램','회복','집단',1,'매주','센터','담당자',10,'운영 중',today);
    db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run('RUN-PHONE','PRG-PHONE',1,'1차',today,'진행 중');
    db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)').run('SESSION-PHONE','RUN-PHONE',1,today,'10:00','센터');
    db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (?,?,?,?,?,?,?)').run(701,'P-PHONE-1','PRG-PHONE','RUN-PHONE',today,'참가중',1);

    const request=(method,url,cookie,body)=>new Request(origin+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{})},...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const get=(url,cookie='')=>GET(request('GET',url,cookie));
    const post=(body,cookie='')=>POST(request('POST','/api/data',cookie,body));
    const login=async(username,pin)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}};
    const assertStaffPhoneFree=body=>{assert.equal(body.currentUser.role,'일반 담당자');for(const participant of body.participants)assert.equal(Object.hasOwn(participant,'phone'),false);for(const application of body.applications)assert.equal(Object.hasOwn(application,'phone'),false);const serialized=JSON.stringify(body);for(const phone of [sentinel,normalized,'010-1111-2222'])assert.equal(serialized.includes(phone),false,phone)};

    const staff=await login('phone-staff','75310864');assertStaffPhoneFree(staff.body);
    const staffGet=await get('/api/data',staff.cookie);assert.equal(staffGet.status,200);assert.equal(staffGet.headers.get('cache-control'),'no-store');assertStaffPhoneFree(await staffGet.json());

    const mutations=[
      {action:'updateParticipant',id:'P-PHONE-1',name:'동일번호 1 수정',gender:'미입력',age:0,phone:sentinel,memberStatus:'회원',note:'메모 1'},
      {action:'applicationStatus',id:701,status:'참가중',reason:''},
      {action:'attendance',applicationId:701,sessionId:'SESSION-PHONE',status:'참석',note:'',contactedAt:'',makeupForSessionId:''},
      {action:'createScheduleEvent',participantId:'P-PHONE-1',title:'연락 일정',eventDate:today,eventType:'상담',color:'green',allDay:false,startTime:'11:00',endTime:'12:00',recurrence:'1회',deliveryMode:'대면'},
      {action:'import',rows:[{name:'가져온 참가자',gender:'미입력',age:0,phone:'010-5555-6666',memberStatus:'비회원',programName:'연락처 프로그램',appliedAt:today}]},
      {action:'createParticipant',name:'새 참가자',gender:'미입력',age:0,phone:'010-3333-4444',memberStatus:'비회원',note:'',programIds:[]},
    ];
    for(const mutation of mutations){const response=await post(mutation,staff.cookie);assert.equal(response.status,200,mutation.action);assertStaffPhoneFree(await response.json())}

    const validSearches=['01098765432','010-9876-5432','010 9876 5432'];
    for(const phone of validSearches){const response=await post({action:'participantPhoneSearch',phone,limit:99999,partial:true,includePhone:true,fields:'*',includeAll:true},staff.cookie);assert.equal(response.status,200,phone);assert.equal(response.headers.get('cache-control'),'no-store');const body=await response.json();assert.deepEqual(Object.keys(body),['results']);assert.equal(body.results.length,5);for(const result of body.results){assert.deepEqual(Object.keys(result).sort(),['id','masked_phone','member_status','name']);assert.equal(result.masked_phone,'010-****-5432');assert.equal(JSON.stringify(result).includes(sentinel),false);assert.equal(JSON.stringify(result).includes(normalized),false)}assert.equal(body.results.some(result=>result.id==='P-PHONE-X'),false)}
    for(const phone of ['', ' ', '1234','5678','0101234','010','*','%','_','abcdefghij','010-123-456','010123456789','abc01098765432']){const response=await post({action:'participantPhoneSearch',phone},staff.cookie);assert.equal(response.status,400,phone);const text=JSON.stringify(await response.json());assert.equal(text.includes(sentinel),false);assert.equal(text.includes(normalized),false)}

    const detail=await get('/api/data?resource=participant&id=P-PHONE-1',staff.cookie);assert.equal(detail.status,200);assert.equal(detail.headers.get('cache-control'),'no-store');const detailBody=await detail.json();assert.equal(detailBody.participant.phone,sentinel);assert.equal(JSON.stringify(detailBody).includes('010-1111-2222'),false);
    for(const url of ['/api/data?resource=participant','/api/data?resource=participant&id=','/api/data?resource=participant&id=%20','/api/data?resource=participant&id=*','/api/data?resource=participant&id=0','/api/data?resource=participant&id=-1','/api/data?resource=participant&id=1.5','/api/data?resource=participant&id=NaN','/api/data?resource=participant&id=P-PHONE-1&id=P-PHONE-X'])assert.equal((await get(url,staff.cookie)).status,400,url);
    assert.equal((await get('/api/data?resource=participant&id=P-NOT-FOUND',staff.cookie)).status,404);

    const duplicateCreate=await post({action:'createParticipant',name:'동일번호 1 수정',gender:'미입력',age:0,phone:sentinel,memberStatus:'회원',note:'',programIds:[]},staff.cookie);assert.equal(duplicateCreate.status,409);const duplicateCreateBody=await duplicateCreate.json();assert.deepEqual(duplicateCreateBody.duplicate,{id:'P-PHONE-1',name:'동일번호 1 수정',phoneMatched:true});assert.equal(JSON.stringify(duplicateCreateBody).includes(sentinel),false);
    const duplicateUpdate=await post({action:'updateParticipant',id:'P-PHONE-X',name:'동일번호 1 수정',gender:'미입력',age:0,phone:sentinel,memberStatus:'비회원',note:'다른 메모'},staff.cookie);assert.equal(duplicateUpdate.status,409);assert.equal(JSON.stringify(await duplicateUpdate.json()).includes(sentinel),false);

    const attendance=await login('phone-attendance','24681357');assert.equal(JSON.stringify(attendance.body).includes(sentinel),false);assert.equal((await post({action:'participantPhoneSearch',phone:sentinel},attendance.cookie)).status,403);assert.equal((await get('/api/data?resource=participant&id=P-PHONE-1',attendance.cookie)).status,403);
    const temporary=await login('phone-temp','13572468');assert.equal((await post({action:'participantPhoneSearch',phone:sentinel},temporary.cookie)).status,403);assert.equal((await get('/api/data?resource=participant&id=P-PHONE-1',temporary.cookie)).status,403);
    assert.equal((await post({action:'participantPhoneSearch',phone:sentinel})).status,401);assert.equal((await get('/api/data?resource=participant&id=P-PHONE-1')).status,401);

    const admin=await login('phone-admin','86420975');assert.equal(admin.body.participants.some(participant=>participant.phone===sentinel),true);assert.equal(admin.body.applications.some(application=>application.phone===sentinel),true);
    const audit=JSON.stringify(db.prepare('SELECT actor,action,entity_type,entity_id,before_json,after_json,summary,reason,ip_address FROM audit_logs').all());for(const phone of [sentinel,normalized,'010-1111-2222','010-5555-6666','010-3333-4444'])assert.equal(audit.includes(phone),false,phone);
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('staff UI는 bulk phone 대신 단건 detail과 POST exact search를 사용한다',()=>{
  const page=readFileSync(path.join(projectRoot,'app','page.tsx'),'utf8'),calendar=readFileSync(path.join(projectRoot,'app','components','calendar.tsx'),'utf8');
  assert.match(page,/action:'participantPhoneSearch'/);
  assert.match(page,/resource=participant&id=\$\{encodeURIComponent\(participant\.id\)\}/);
  assert.match(page,/function ContactButton/);
  assert.match(page,/`\$\{p\.name\}\$\{p\.id\}`\.includes\(query\)/);
  assert.doesNotMatch(page,/`\$\{p\.name\}\$\{p\.id\}\$\{p\.phone\}`\.includes\(query\)/);
  assert.doesNotMatch(page,/app\.run_label} · \{app\.phone\}/);
  assert.match(calendar,/participant\.name} · \{participant\.id\}/);
  assert.doesNotMatch(calendar,/participant\.phone/);
  const editFlow=page.slice(page.indexOf('const openParticipantDetail='),page.indexOf('const loadAuditLogs='));
  assert.ok(editFlow.indexOf('j.participant.id!==participant.id')<editFlow.indexOf("setModal('editParticipant')"));
  assert.match(page,/function EditParticipantModal\(\{person,onClose,onSubmit\}:\{person:ParticipantDetail/);
});
