import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import * as XLSX from 'xlsx';
import { formatExcelApplicationDate } from '../lib/excel-import.ts';
import { formatKoreanPhoneInput } from '../lib/phone-input.ts';

const projectRoot=path.resolve(import.meta.dirname,'..');
function runNode(source,environment){return spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,...environment},encoding:'utf8'});}

test('Sprint 2A: phone input formatter normalizes typing, pastes, and maximum length',()=>{
  assert.equal(formatKoreanPhoneInput('01012345678'),'010-1234-5678');
  assert.equal(formatKoreanPhoneInput('010-1234-5678'),'010-1234-5678');
  assert.equal(formatKoreanPhoneInput('010 1234 5678'),'010-1234-5678');
  assert.equal(formatKoreanPhoneInput('0101234'),'010-1234');
  assert.equal(formatKoreanPhoneInput('010abc123456789'),'010-1234-5678');
  assert.equal(formatExcelApplicationDate(45292),'2024-01-01');
  assert.equal(formatExcelApplicationDate('2026-09-17'),'2026-09-17');
  const sheet=XLSX.utils.json_to_sheet([{이름:'가상 신청자',연락처:'010 1234 5678',회원여부:'회원','신청한 프로그램':'Sprint 2A 프로그램',신청일:45292}]);
  const row=XLSX.utils.sheet_to_json(sheet)[0];
  assert.equal(row['신청한 프로그램'],'Sprint 2A 프로그램');
  assert.equal(formatExcelApplicationDate(row['신청일']),'2024-01-01');
});

test('Sprint 2A: application status is canonical in DB and snapshot; import returns fresh rows and rolls back unexpected failures',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-sprint-2a-'));
  try{
    const databasePath=path.join(directory,'test.sqlite'),backupDirectory=path.join(directory,'backups');
    const source=String.raw`
      import assert from 'node:assert/strict';
      import { POST } from './app/api/data/route.ts';
      import { getDatabase,hashPin } from './db/index.ts';
      const db=getDatabase(),today='2026-09-17',importToday=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}),origin='http://localhost:3000';
      db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('USR-S2A','s2a-admin','Sprint 관리자',hashPin('s2a-admin','86420975'),'관리자',today);
      db.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('PRG-S2A','Sprint 2A 프로그램','회복','집단',1,'매주','센터','담당자',20,'운영 중',today);
      db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-S2A','상태 전환 대상','미입력',0,'010-0000-0000','비회원','',today);
      const applicationId=Number(db.prepare('INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,?,?,?)').run('P-S2A','PRG-S2A',today,'신청',1,today).lastInsertRowid);
      const post=(body,cookie='')=>POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(cookie?{Cookie:cookie}:{})},body:JSON.stringify(body)}));
      const login=await post({action:'login',username:'s2a-admin',pin:'86420975'}),cookie=login.headers.get('set-cookie').split(';')[0];
      for(const status of ['선정검토','참가대기','참가중','참가완료']){
        const auditBefore=db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='상태 변경' AND entity_id=?").get(String(applicationId)).count;
        const response=await post({action:'applicationStatus',id:applicationId,status,reason:''},cookie),body=await response.json();
        assert.equal(response.status,200);assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId).status,status);
        assert.equal(body.applications.find(item=>item.id===applicationId).status,status);
        assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='상태 변경' AND entity_id=?").get(String(applicationId)).count,auditBefore+1);
      }
      const missingWithdrawalReason=await post({action:'applicationStatus',id:applicationId,status:'중도탈락',reason:''},cookie);
      assert.equal(missingWithdrawalReason.status,400);assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId).status,'참가완료');
      const withdrawal=await post({action:'applicationStatus',id:applicationId,status:'중도탈락',reason:'개인 사정'},cookie),withdrawalBody=await withdrawal.json();
      assert.equal(withdrawal.status,200);assert.equal(db.prepare('SELECT status FROM applications WHERE id=?').get(applicationId).status,'중도탈락');assert.equal(db.prepare('SELECT status_reason FROM applications WHERE id=?').get(applicationId).status_reason,'개인 사정');assert.equal(withdrawalBody.updatedApplicationReason.reasonPresent,true);
      db.prepare('INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,?,?,?)').run('P-S2A-CANCEL','취소 전환 대상','미입력',0,'010-0000-0001','비회원','',today);
      const cancelApplicationId=Number(db.prepare('INSERT INTO applications (participant_id,program_id,run_id,applied_at,status,queue_number,status_updated_at) VALUES (?,?,NULL,?,?,?,?)').run('P-S2A-CANCEL','PRG-S2A',today,'참가중',2,today).lastInsertRowid);
      const missingCancelReason=await post({action:'applicationStatus',id:cancelApplicationId,status:'취소',reason:''},cookie);assert.equal(missingCancelReason.status,400);
      const cancel=await post({action:'applicationStatus',id:cancelApplicationId,status:'취소',reason:'일정 변경'},cookie);assert.equal(cancel.status,200);assert.equal(db.prepare('SELECT status_reason FROM applications WHERE id=?').get(cancelApplicationId).status_reason,'일정 변경');
      const importResponse=await post({action:'import',rows:[
        {name:'Excel 신규 A',phone:'010-1000-0001',programName:'Sprint 2A 프로그램',appliedAt:'2026-09-17'},
        {name:'Excel 신규 B',phone:'010-1000-0002',programName:'Sprint 2A 프로그램',appliedAt:'2026-09-18'},
        {name:'Excel 제외',phone:'010-1000-0003',programName:'없는 프로그램',appliedAt:'2026-09-19'},
      ]},cookie),importBody=await importResponse.json();
      assert.equal(importResponse.status,200);assert.deepEqual(importBody.importResult,{processedCount:3,acceptedCount:2,participantCreatedCount:2,applicationCreatedCount:2,applicationUpdatedCount:0,rejectedCount:1,rejectedRows:[{rowNumber:4,reason:'프로그램명을 찾을 수 없습니다.'}]});
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM participants WHERE name LIKE 'Excel 신규 %'").get().count,2);
      assert.equal(db.prepare("SELECT COUNT(*) AS count FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name LIKE 'Excel 신규 %' AND a.program_id='PRG-S2A'").get().count,2);
      assert.equal(importBody.applications.filter(item=>item.participant_name.startsWith('Excel 신규 ')).length,2);
      const optionalDate=await post({action:'import',rows:[{name:'Excel 기본 신청일',phone:'010-1000-0004',programName:'Sprint 2A 프로그램'}]},cookie),optionalDateBody=await optionalDate.json();
      assert.equal(optionalDate.status,200);assert.equal(optionalDateBody.importResult.acceptedCount,1);assert.equal(db.prepare("SELECT applied_at FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name='Excel 기본 신청일'").get().applied_at,importToday);
      const contextProgram=await post({action:'import',programId:'PRG-S2A',rows:[{name:'Excel 프로그램 생략',phone:'010-1000-0005'}]},cookie),contextProgramBody=await contextProgram.json();
      assert.equal(contextProgram.status,200);assert.equal(contextProgramBody.importResult.acceptedCount,1);assert.equal(db.prepare("SELECT a.program_id FROM applications a JOIN participants p ON p.id=a.participant_id WHERE p.name='Excel 프로그램 생략'").get().program_id,'PRG-S2A');
      const noProgram=await post({action:'import',rows:[{name:'Excel 프로그램 누락',phone:'010-1000-0006'}]},cookie),noProgramBody=await noProgram.json();
      assert.equal(noProgram.status,200);assert.equal(noProgramBody.importResult.rejectedCount,1);assert.deepEqual(noProgramBody.importResult.rejectedRows,[{rowNumber:2,reason:'프로그램명 또는 선택한 프로그램이 필요합니다.'}]);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM participants WHERE name='Excel 프로그램 누락'").get().count,0);
      const importAuditBefore=db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='import_complete'").get().count;
      db.exec("CREATE TRIGGER fail_s2a_import BEFORE INSERT ON participants WHEN NEW.name='Excel rollback B' BEGIN SELECT RAISE(ABORT,'injected import failure'); END");
      const failed=await post({action:'import',rows:[{name:'Excel rollback A',phone:'010-1000-0011',programName:'Sprint 2A 프로그램'},{name:'Excel rollback B',phone:'010-1000-0012',programName:'Sprint 2A 프로그램'}]},cookie);
      assert.equal(failed.status,500);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM participants WHERE name LIKE 'Excel rollback %'").get().count,0);assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='import_complete'").get().count,importAuditBefore);
      db.exec('DROP TRIGGER fail_s2a_import');db.close();console.log(JSON.stringify({ok:true}));
    `;
    const result=runNode(source,{NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BACKUP_DIR:backupDirectory,ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'});
    assert.equal(result.status,0,result.stderr||result.stdout);assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
    const page=readFileSync(path.join(projectRoot,'app/page.tsx'),'utf8');assert.match(page,/신청한 프로그램/);assert.match(page,/importResult/);assert.match(page,/rejectedRows/);assert.match(page,/ImportRejectModal/);assert.match(page,/StatusReasonModal/);assert.match(page,/사유를 기록해야/);assert.match(page,/선택한 프로그램으로 등록/);assert.match(page,/formatKoreanPhoneInput/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});