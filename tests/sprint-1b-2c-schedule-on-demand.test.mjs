import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { inclusiveCalendarDays, isCanonicalCalendarDate, isScheduleDataReady, isScheduleResponseCurrent, visibleScheduleDateKeys, visibleScheduleRange } from '../lib/schedule-state.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('staff 일정 원자료는 visible range에서만 최소 DTO로 조회되고 생성 검증이 유지된다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-schedule-scope-'));
  const databasePath=path.join(directory,'schedule.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import { GET,POST } from './app/api/data/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-13';
    for(const row of [
      ['USR-SCH-ADMIN','schedule-admin','일정 관리자','86420975','관리자',0],
      ['USR-SCH-STAFF','schedule-staff','일정 담당자','75310864','일반 담당자',0],
      ['USR-SCH-ONLY','schedule-only','출석 담당자','24681357','출석 입력 전용',0],
      ['USR-SCH-TEMP','schedule-temp','임시 담당자','13572468','일반 담당자',1],
    ])db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,?)').run(row[0],row[1],row[2],hashPin(row[1],row[3]),row[4],today,row[5]);
    for(const row of [['P-SCH-1','일정 참가자'],['P-SCH-2','경계 참가자']])db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'미입력',0,'010-0000-0000','비회원','',?)").run(row[0],row[1],today);
    db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES ('PRG-SCH','일정 프로그램','회복','집단',1,'매주','센터','담당자',10,'운영 중',?)").run(today);
    db.prepare("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES ('RUN-SCH','PRG-SCH',1,'1차',?,'진행 중')").run(today);
    db.prepare("INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES ('SESSION-SCH','RUN-SCH',1,?,'10:00','센터')").run(today);
    db.prepare("INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (801,'P-SCH-1','PRG-SCH','RUN-SCH',?,'참가중',1)").run(today);
    const events=[
      ['SCH-BEFORE','P-SCH-1','BEFORE_RANGE_TITLE_SENTINEL','2026-08-29','09:00'],
      ['SCH-FIRST','P-SCH-1','FIRST_DAY_TITLE_SENTINEL','2026-08-30','09:30'],
      ['SCH-MONTH-END','P-SCH-1','MONTH_END_TITLE_SENTINEL','2026-09-30','23:00'],
      ['SCH-NEXT-MONTH','P-SCH-2','NEXT_MONTH_TITLE_SENTINEL','2026-10-01','00:00'],
      ['SCH-LAST','P-SCH-2','LAST_DAY_TITLE_SENTINEL','2026-10-10','14:00'],
      ['SCH-AFTER','P-SCH-2','AFTER_RANGE_TITLE_SENTINEL','2026-10-11','15:00'],
    ];
    for(const row of events)db.prepare("INSERT INTO schedule_events (id,event_type,color,participant_id,title,event_date,all_day,start_time,end_time,recurrence,delivery_mode,created_at) VALUES (?,'상담','green',?,?,?,0,?,'23:30','1회','대면',?)").run(row[0],row[1],row[2],row[3],row[4],today);

    const request=(method,url,cookie,body)=>new Request(origin+url,{method,headers:{...(cookie?{Cookie:cookie}:{}),...(method==='POST'?{Origin:origin,'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});
    const get=(url,cookie)=>GET(request('GET',url,cookie));
    const post=(body,cookie)=>POST(request('POST','/api/data',cookie,body));
    const login=async(username,pin)=>{const response=await post({action:'login',username,pin});assert.equal(response.status,200);return {body:await response.json(),cookie:response.headers.get('set-cookie').split(';')[0]}};
    const titleSentinels=events.map(row=>row[2]);
    const assertStaffSnapshot=body=>{assert.equal(body.currentUser.role,'일반 담당자');assert.deepEqual(body.scheduleEvents,[]);const serialized=JSON.stringify(body);for(const sentinel of [...titleSentinels,'CREATED_TITLE_SENTINEL'])assert.equal(serialized.includes(sentinel),false,sentinel)};

    const staff=await login('schedule-staff','75310864');assertStaffSnapshot(staff.body);
    const staffGet=await get('/api/data',staff.cookie);assert.equal(staffGet.status,200);assertStaffSnapshot(await staffGet.json());
    const participantMutation=await post({action:'updateParticipant',id:'P-SCH-1',name:'일정 참가자',gender:'미입력',age:0,phone:'010-0000-0000',memberStatus:'비회원',note:''},staff.cookie);assert.equal(participantMutation.status,200);assertStaffSnapshot(await participantMutation.json());
    const applicationMutation=await post({action:'applicationStatus',id:801,status:'참가중',reason:''},staff.cookie);assert.equal(applicationMutation.status,200);assertStaffSnapshot(await applicationMutation.json());
    const otherMutation=await post({action:'updateSession',id:'SESSION-SCH',sessionDate:today,sessionTime:'10:30',location:'센터'},staff.cookie);assert.equal(otherMutation.status,200);assertStaffSnapshot(await otherMutation.json());

    const validCreate={action:'createScheduleEvent',participantId:'P-SCH-1',title:'CREATED_TITLE_SENTINEL',eventDate:'2026-09-15',eventType:'상담',color:'green',allDay:false,startTime:'11:00',endTime:'12:00',recurrence:'1회',deliveryMode:'대면'};
    const created=await post(validCreate,staff.cookie);assert.equal(created.status,200);assertStaffSnapshot(await created.json());assert.equal(db.prepare("SELECT COUNT(*) AS count FROM schedule_events WHERE title='CREATED_TITLE_SENTINEL'").get().count,1);

    const admin=await login('schedule-admin','86420975');assert.ok(JSON.stringify(admin.body).includes('FIRST_DAY_TITLE_SENTINEL'));assert.ok(JSON.stringify(admin.body).includes('CREATED_TITLE_SENTINEL'));
    const attendanceOnly=await login('schedule-only','24681357');assert.deepEqual(attendanceOnly.body.scheduleEvents,[]);
    const temporary=await login('schedule-temp','13572468');

    const rangeUrl='/api/data?resource=schedule&from=2026-08-30&to=2026-10-10';
    const rangeResponse=await get(rangeUrl,staff.cookie);assert.equal(rangeResponse.status,200);assert.equal(rangeResponse.headers.get('cache-control'),'no-store');
    const range=await rangeResponse.json();assert.deepEqual({from:range.from,to:range.to},{from:'2026-08-30',to:'2026-10-10'});
    assert.deepEqual(range.scheduleEvents.map(event=>event.title),['FIRST_DAY_TITLE_SENTINEL','CREATED_TITLE_SENTINEL','MONTH_END_TITLE_SENTINEL','NEXT_MONTH_TITLE_SENTINEL','LAST_DAY_TITLE_SENTINEL']);
    assert.deepEqual(Object.keys(range.scheduleEvents[0]).sort(),['all_day','color','delivery_mode','event_date','event_type','id','participant_id','start_time','title']);
    const serializedRange=JSON.stringify(range);for(const sentinel of ['BEFORE_RANGE_TITLE_SENTINEL','AFTER_RANGE_TITLE_SENTINEL'])assert.equal(serializedRange.includes(sentinel),false,sentinel);
    for(const forbidden of ['participant_name','phone','end_time','recurrence','created_at'])assert.equal(Object.hasOwn(range.scheduleEvents[0],forbidden),false,forbidden);

    const expanded=await get(rangeUrl+'&includeAll=true&fields=*&limit=99999&includeParticipants=true',staff.cookie);assert.equal(expanded.status,200);const expandedBody=await expanded.json();assert.deepEqual(Object.keys(expandedBody.scheduleEvents[0]).sort(),Object.keys(range.scheduleEvents[0]).sort());assert.equal(JSON.stringify(expandedBody).includes('AFTER_RANGE_TITLE_SENTINEL'),false);
    const oneDay=await get('/api/data?resource=schedule&from=2026-09-30&to=2026-09-30',staff.cookie);assert.equal(oneDay.status,200);assert.deepEqual((await oneDay.json()).scheduleEvents.map(event=>event.title),['MONTH_END_TITLE_SENTINEL']);
    assert.equal((await get('/api/data?resource=schedule&from=2026-09-01&to=2026-10-12',staff.cookie)).status,200);

    const invalidUrls=[
      '/api/data?resource=schedule',
      '/api/data?resource=schedule&from=2026-09-01',
      '/api/data?resource=schedule&to=2026-09-01',
      '/api/data?resource=schedule&from=&to=2026-09-01',
      '/api/data?resource=schedule&from=%20%20&to=2026-09-01',
      '/api/data?resource=schedule&from=2026-09-01&to=',
      '/api/data?resource=schedule&from=2026-9-01&to=2026-09-02',
      '/api/data?resource=schedule&from=2026-02-30&to=2026-03-01',
      '/api/data?resource=schedule&from=2026-04-31&to=2026-05-01',
      '/api/data?resource=schedule&from=2026-99-99&to=2027-01-01',
      '/api/data?resource=schedule&from=2026-10-01&to=2026-09-30',
      '/api/data?resource=schedule&from=2026-09-01&to=2026-10-13',
      '/api/data?resource=schedule&from=1900-01-01&to=2100-01-01',
      '/api/data?resource=schedule&from=2026-09-01&from=2026-09-02&to=2026-09-03',
      '/api/data?resource=schedule&from=2026-09-01&to=2026-09-02&to=2026-09-03',
      '/api/data?resource=schedule&from=*&to=2026-09-01',
      '/api/data?resource=schedule&from=%25&to=2026-09-01',
      '/api/data?resource=schedule&from=_&to=2026-09-01',
    ];
    for(const url of invalidUrls){const response=await get(url,staff.cookie);assert.ok(response.status>=400&&response.status<500,url);assert.equal(response.headers.get('cache-control'),'no-store');const body=JSON.stringify(await response.json());for(const sentinel of [...titleSentinels,'CREATED_TITLE_SENTINEL'])assert.equal(body.includes(sentinel),false,url)}
    assert.equal((await get(rangeUrl)).status,401);assert.equal((await get(rangeUrl,attendanceOnly.cookie)).status,403);assert.equal((await get(rangeUrl,temporary.cookie)).status,403);assert.equal((await get(rangeUrl,admin.cookie)).status,200);

    const auditCount=()=>db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,eventCount=()=>db.prepare('SELECT COUNT(*) AS count FROM schedule_events').get().count;
    const beforeAudit=auditCount(),beforeEvents=eventCount();
    const invalidCreates=[
      {...validCreate,title:'INVALID_PARTICIPANT_TITLE',participantId:'P-NOT-FOUND'},
      {...validCreate,title:'INVALID_DATE_TITLE',eventDate:'2026-02-30'},
      {...validCreate,title:'INVALID_TIME_TITLE',startTime:'9:00'},
      {...validCreate,title:'INVALID_ORDER_TITLE',startTime:'12:00',endTime:'11:00'},
      {...validCreate,title:'INVALID_ALL_DAY_TITLE',allDay:'false'},
      {...validCreate,title:'INVALID_RECURRENCE_TITLE',recurrence:'매시간'},
      {...validCreate,title:'INVALID_DELIVERY_TITLE',deliveryMode:'온라인 링크'},
    ];
    for(const payload of invalidCreates){const response=await post(payload,staff.cookie);assert.ok(response.status>=400&&response.status<500,payload.title);assert.equal(JSON.stringify(await response.json()).includes(payload.title),false);assert.equal(eventCount(),beforeEvents);assert.equal(auditCount(),beforeAudit)}
    const auditSerialized=JSON.stringify(db.prepare('SELECT * FROM audit_logs').all());assert.equal(auditSerialized.includes('CREATED_TITLE_SENTINEL'),false);assert.ok(auditSerialized.includes('title_present'));
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:path.join(directory,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true})}
});

test('달력 visible range와 freshness helper는 월경계와 stale response를 방어한다',()=>{
  assert.equal(isCanonicalCalendarDate('2026-02-28'),true);
  for(const value of ['2026-02-30','2026-04-31','2026-99-99','2026-2-01','*',''])assert.equal(isCanonicalCalendarDate(value),false,value);
  assert.equal(inclusiveCalendarDays('2026-09-01','2026-10-12'),42);
  assert.equal(inclusiveCalendarDays('2026-09-01','2026-10-13'),43);
  const monthDates=visibleScheduleDateKeys('2026-09-13','2026-09-13','month');
  assert.equal(monthDates.length,42);assert.equal(monthDates[0],'2026-08-30');assert.equal(monthDates.at(-1),'2026-10-10');
  const weekDates=visibleScheduleDateKeys('2026-09-30','2026-10-01','week');
  assert.deepEqual(weekDates,['2026-09-27','2026-09-28','2026-09-29','2026-09-30','2026-10-01','2026-10-02','2026-10-03']);
  assert.deepEqual(visibleScheduleRange('2026-09-13','2026-09-13','month'),{from:'2026-08-30',to:'2026-10-10'});
  assert.equal(isScheduleResponseCurrent({from:'2026-10-01',to:'2026-11-11'},{from:'2026-09-01',to:'2026-10-12'},{from:'2026-09-01',to:'2026-10-12'}),false);
  assert.equal(isScheduleResponseCurrent({from:'2026-10-01',to:'2026-11-11'},{from:'2026-10-01',to:'2026-11-11'},{from:'2026-09-01',to:'2026-10-12'}),false);
  assert.equal(isScheduleResponseCurrent({from:'2026-10-01',to:'2026-11-11'},{from:'2026-10-01',to:'2026-11-11'},{from:'2026-10-01',to:'2026-11-11'}),true);
  assert.equal(isScheduleDataReady(true,true,false,true,''),true);assert.equal(isScheduleDataReady(true,false,false,true,''),false);assert.equal(isScheduleDataReady(true,true,false,false,'reload failed'),false);assert.equal(isScheduleDataReady(false,false,true,false,'admin snapshot'),true);
  const calendar=readFileSync(path.join(projectRoot,'app/components/calendar.tsx'),'utf8');
  assert.match(calendar,/resource=schedule&from=/);assert.match(calendar,/scheduleAbort\.current\?\.abort\(\)/);assert.match(calendar,/isScheduleResponseCurrent/);assert.match(calendar,/setScheduleFresh\(false\)/);assert.match(calendar,/setScheduleFresh\(true\)/);assert.match(calendar,/await loadScheduleRange\(currentRange\.current,true,true\)/);assert.match(calendar,/participantNames\.get\(event\.participant_id\)/);
  for(const pattern of [/localStorage/,/sessionStorage/,/indexedDB/,/console\./])assert.doesNotMatch(calendar,pattern);
});
