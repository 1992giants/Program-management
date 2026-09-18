import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const root=path.resolve(import.meta.dirname,'..');
function run(source,env){return spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','--eval',source],{cwd:root,env:{...process.env,...env},encoding:'utf8'});}

test('Sprint 2 Beta C2: Excel import returns exact results and preserves canonical program/run history',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-c2-'));
  try{
    const databasePath=path.join(directory,'test.sqlite'),backupDirectory=path.join(directory,'backups');
    const source=String.raw`
      import assert from 'node:assert/strict';
      import { POST } from './app/api/data/route.ts';
      import { getDatabase,hashPin } from './db/index.ts';
      const db=getDatabase(),origin='http://localhost:3000',today='2026-09-18';
      db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-C2','c2','C2 관리자',hashPin('c2','86420975'),'관리자',today);
      for(const [id,name] of [['PA','프로그램 A'],['PB','프로그램 B']])db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,name,'분류','집단',1,'매주','센터','담당',2000,'운영 중',today);
      db.exec("INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES ('RA1','PA',1,'A 1차',?,'모집 중'),('RA2','PA',2,'A 2차',?,'모집 중'),('RB1','PB',1,'B 1차',?,'모집 중')".replaceAll('?',"'2026-09-18'"));
      db.prepare('INSERT INTO sessions (id,run_id,session_number,session_date,session_time,location) VALUES (?,?,?,?,?,?)').run('SA1','RA1',1,today,'10:00','센터');
      const post=(body,cookie='')=>POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)}));
      const login=await post({action:'login',username:'c2',pin:'86420975'}),cookie=login.headers.get('set-cookie').split(';')[0];
      const partial=await post({action:'import',rows:[{name:'정상 A',phone:'010-1111-1111',memberStatus:'회원',programName:'프로그램 A',runLabel:'A 1차',appliedAt:'2026-09-18'},{name:'정상 B',phone:'010 2222 2222',programName:'프로그램 A'},{name:'제외 C',phone:'010-3333-3333',programName:'없는 프로그램'}]},cookie),partialBody=await partial.json();
      assert.equal(partial.status,200);assert.deepEqual(partialBody.importResult,{totalRows:3,acceptedRows:2,createdParticipants:2,existingParticipants:0,createdApplications:2,updatedApplications:0,rejectedRows:1,rejected:[{rowNumber:4,code:'program_not_found',message:'프로그램을 확인할 수 없습니다.'}]});
      assert.equal(db.prepare("SELECT run_id FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name='정상 A'").get().run_id,'RA1');
      const contextOptional=await post({action:'import',programId:'PA',rows:[{name:'컨텍스트 프로그램',phone:'010-4444-4444'}]},cookie),contextOptionalBody=await contextOptional.json();
      assert.equal(contextOptional.status,200);assert.equal(contextOptionalBody.importResult.acceptedRows,1);assert.equal(db.prepare("SELECT applied_at,run_id FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name='컨텍스트 프로그램'").get().run_id,null);
      const mismatch=await post({action:'import',rows:[{name:'차수 불일치',phone:'010-5555-5555',programName:'프로그램 A',runLabel:'B 1차'}]},cookie),mismatchBody=await mismatch.json();
      assert.equal(mismatch.status,200);assert.deepEqual(mismatchBody.importResult.rejected,[{rowNumber:2,code:'program_run_mismatch',message:'프로그램과 차수가 일치하지 않습니다.'}]);
      const missingRun=await post({action:'import',rows:[{name:'없는 차수',phone:'010-6666-6666',programName:'프로그램 A',runLabel:'999차'}]},cookie),missingRunBody=await missingRun.json();
      assert.equal(missingRun.status,200);assert.deepEqual(missingRunBody.importResult.rejected,[{rowNumber:2,code:'run_not_found',message:'차수를 확인할 수 없습니다.'}]);
      db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('PH','이력 참가자','미입력',0,'010-7777-7777','비회원','',today);
      const historicalId=Number(db.prepare("INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES ('PH','PA','RA1',?,'참가중',99,?)").run(today,today).lastInsertRowid);
      db.prepare("INSERT INTO attendance (application_id,session_id,status,note) VALUES (?,?,'참석','')").run(historicalId,'SA1');
      const historical=await post({action:'import',rows:[{name:'이력 참가자',phone:'01077777777',programName:'프로그램 A',runLabel:'A 2차'}]},cookie),historicalBody=await historical.json();
      assert.equal(historical.status,200);assert.deepEqual(historicalBody.importResult.rejected,[{rowNumber:2,code:'historical_run_reassignment',message:'기존 운영 이력이 있는 신청은 다른 차수로 재배정할 수 없습니다.'}]);assert.equal(db.prepare('SELECT run_id FROM applications WHERE id=?').get(historicalId).run_id,'RA1');
      db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('PD','전화 중복','미입력',0,'010-8888-8888','비회원','',today);
      const duplicate=await post({action:'import',rows:[{name:'전화 중복',phone:'01088888888',programName:'프로그램 A'}]},cookie),duplicateBody=await duplicate.json();
      assert.equal(duplicate.status,200);assert.equal(duplicateBody.importResult.existingParticipants,1);assert.equal(duplicateBody.importResult.createdParticipants,0);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM participants WHERE name='전화 중복'").get().count,1);
      const thousand=Array.from({length:1000},(_,index)=>({name:'천건'+index,phone:'010'+String(index).padStart(8,'0'),programName:'프로그램 B'}));
      const allowed=await post({action:'import',rows:thousand},cookie),allowedBody=await allowed.json();
      assert.equal(allowed.status,200);assert.equal(allowedBody.importResult.totalRows,1000);assert.equal(allowedBody.importResult.acceptedRows,1000);
      const beforeParticipants=db.prepare('SELECT COUNT(*) AS count FROM participants').get().count,beforeApplications=db.prepare('SELECT COUNT(*) AS count FROM applications').get().count,beforeAudit=db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='import_complete'").get().count;
      const tooMany=await post({action:'import',rows:Array.from({length:1001},(_,index)=>({name:'초과'+index,phone:'010'+String(index).padStart(8,'0'),programName:'프로그램 B'}))},cookie);
      assert.equal(tooMany.status,400);assert.match((await tooMany.json()).error,/최대 1,000행/);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM participants').get().count,beforeParticipants);assert.equal(db.prepare('SELECT COUNT(*) AS count FROM applications').get().count,beforeApplications);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='import_complete'").get().count,beforeAudit);
      db.close();console.log(JSON.stringify({ok:true}));
    `;
    const result=run(source,{NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory,ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true});}
});
test('Sprint 2 Beta C2: import UI displays only the authoritative server result contract',()=>{
  const page=readFileSync(path.join(root,'app/page.tsx'),'utf8');
  assert.match(page,/summary\.totalRows/);assert.match(page,/summary\.acceptedRows/);assert.match(page,/summary\.rejectedRows/);assert.match(page,/item\.rowNumber.*item\.message/);assert.match(page,/row\['차수명'\].*row\.run.*row\.runLabel/);assert.doesNotMatch(page,/\$\{rows\.length\}행을 가져왔습니다/);
});
