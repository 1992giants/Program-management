import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const projectRoot=path.resolve(import.meta.dirname,'..');

test('서버 Excel export는 역할·범위·최소 컬럼·감사·formula 방어를 강제한다',()=>{
  const directory=mkdtempSync(path.join(tmpdir(),'onmaeum-export-security-'));
  const databasePath=path.join(directory,'export-test.sqlite');
  const source=`
    import assert from 'node:assert/strict';
    import * as XLSX from 'xlsx';
    import { POST as dataPOST } from './app/api/data/route.ts';
    import { POST as exportPOST } from './app/api/export/applications/route.ts';
    import { getDatabase,hashPin } from './db/index.ts';

    const db=getDatabase(),origin='http://localhost:3000',today='2026-09-12';
    const users=[
      ['USR-EXPORT-ADMIN','export-admin','내보내기 관리자','86420975','관리자'],
      ['USR-EXPORT-STAFF','export-staff','내보내기 담당자','75310864','일반 담당자'],
      ['USR-EXPORT-ATTENDANCE','export-attendance','출석 담당자','24681357','출석 입력 전용'],
    ];
    for(const [id,username,displayName,pin,role] of users)db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run(id,username,displayName,hashPin(username,pin),role,today);
    db.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,1)').run('USR-EXPORT-TEMP','export-temp','PIN 변경 대기',hashPin('export-temp','13579024'),'관리자',today);
    const programs=[['PRG-EXPORT-A','=1+1'],['PRG-EXPORT-B',' =1+1'],['PRG-EXPORT-EMPTY','빈 프로그램']];
    for(const [id,name] of programs)db.prepare("INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,'집단',1,'매주','센터','담당자',10,'운영 중',?)").run(id,name,'회복',today);
    db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run('RUN-EXPORT-A','PRG-EXPORT-A',1,'+1+1',today,'진행 중');
    db.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run('RUN-EXPORT-B','PRG-EXPORT-B',1,String.fromCharCode(9)+'=1+1',today,'진행 중');
    const people=[
      ['=1+1','=1+1','=010-1000-1000'],
      ['+1+1','+1+1','+010-2000-2000'],
      ['-1+1','-1+1','-010-3000-3000'],
      ['@SUM(1,1)','@SUM(1,1)','@010-4000-4000'],
      ['P-EXPORT-B','일반 참가자','010-5000-5000'],
    ];
    for(const [id,name,phone] of people)db.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,'여성',40,?,'회원','sensitive memo text',?)").run(id,name,phone,today);
    const insertApplication=db.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number,status_reason) VALUES (?,?,?,?,?,?,?,?)');
    people.slice(0,4).forEach((person,index)=>insertApplication.run(201+index,person[0],'PRG-EXPORT-A','RUN-EXPORT-A',today,'참가중',index+1,'절대 반출 금지 사유'));
    insertApplication.run(205,'P-EXPORT-B','PRG-EXPORT-B','RUN-EXPORT-B',today,'신청',1,'다른 프로그램 사유');
    db.prepare("INSERT INTO assessment_catalog (id,name,min_score,max_score,active,created_at) VALUES ('ASM-EXPORT','보안검사',0,10,1,?)").run(today);
    db.prepare("INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at) VALUES (201,'ASM-EXPORT',8,2,'검사 비밀 메모',?)").run(today);
    db.prepare("INSERT INTO satisfaction_surveys (application_id,score,comment,updated_at) VALUES (201,5,'만족도 비밀 의견',?)").run(today);

    const login=async(username,pin)=>{const response=await dataPOST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json'},body:JSON.stringify({action:'login',username,pin})}));assert.equal(response.status,200);return response.headers.get('set-cookie').split(';')[0]};
    const admin=await login('export-admin','86420975'),staff=await login('export-staff','75310864'),attendance=await login('export-attendance','24681357'),temporaryAdmin=await login('export-temp','13579024');
    const request=(body,cookie,headers={})=>exportPOST(new Request(origin+'/api/export/applications',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:cookie,...headers},body:JSON.stringify(body)}));
    const workbook=async response=>{assert.equal(response.status,200);assert.match(response.headers.get('content-type'),/spreadsheetml/);assert.match(response.headers.get('content-disposition')||'',/^attachment; filename\\*=UTF-8''/);assert.equal(response.headers.get('cache-control'),'no-store');const book=XLSX.read(await response.arrayBuffer(),{type:'array'});assert.equal(book.SheetNames.length,1);assert.equal(Boolean(book.Workbook?.Sheets?.some(sheet=>sheet.Hidden)),false);assert.equal(Boolean(book.Sheets[book.SheetNames[0]]['!cols']),false);return book};
    const sheetRows=book=>XLSX.utils.sheet_to_json(book.Sheets[book.SheetNames[0]],{defval:null});

    const adminApplicationBook=await workbook(await request({export_type:'application_roster'},admin));
    const adminApplicationRows=sheetRows(adminApplicationBook);
    assert.equal(adminApplicationRows.length,5);
    assert.deepEqual(Object.keys(adminApplicationRows[0]),['관리번호','이름','프로그램','차수','신청일','신청상태','대기순번']);
    const applicationText=JSON.stringify(adminApplicationRows);
    for(const forbidden of ['010-1000-1000','sensitive memo text','절대 반출 금지 사유','여성','보안검사','검사 비밀 메모','만족도 비밀 의견'])assert.equal(applicationText.includes(forbidden),false);

    const staffApplicationBook=await workbook(await request({export_type:'application_roster',program_id:'PRG-EXPORT-A',columns:['phone','memo'],includePhone:true},staff));
    assert.equal(sheetRows(staffApplicationBook).length,4);
    const formulaSheet=staffApplicationBook.Sheets[staffApplicationBook.SheetNames[0]];
    for(const address of ['A2','B2','C2','D2','A3','B3','A4','B4','A5','B5']){const cell=formulaSheet[address];assert.equal(cell.t,'s');assert.equal(Boolean(cell.f),false);assert.match(String(cell.v),/^'/)}
    const leadingSpaceCell=adminApplicationBook.Sheets[adminApplicationBook.SheetNames[0]]['C6'];assert.equal(leadingSpaceCell.t,'s');assert.equal(Boolean(leadingSpaceCell.f),false);assert.match(String(leadingSpaceCell.v),/^ =1\\+1$/);
    const leadingTabCell=adminApplicationBook.Sheets[adminApplicationBook.SheetNames[0]]['D6'];assert.equal(leadingTabCell.t,'s');assert.equal(Boolean(leadingTabCell.f),false);assert.match(String(leadingTabCell.v),/^\\t=1\\+1$/);

    const contactBook=await workbook(await request({export_type:'contact_roster',program_id:'PRG-EXPORT-A'},admin));
    const contactRows=sheetRows(contactBook),contactText=JSON.stringify(contactRows);
    assert.deepEqual(Object.keys(contactRows[0]),['관리번호','이름','연락처','프로그램','차수','신청상태']);
    assert.equal(contactText.includes('010-1000-1000'),true);
    for(const address of ['A2','B2','C2','D2','E2']){const cell=contactBook.Sheets[contactBook.SheetNames[0]][address];assert.equal(cell.t,'s');assert.equal(Boolean(cell.f),false);assert.match(String(cell.v),/^'/)}
    for(const forbidden of ['sensitive memo text','절대 반출 금지 사유','여성','보안검사','검사 비밀 메모','만족도 비밀 의견'])assert.equal(contactText.includes(forbidden),false);

    assert.equal((await request({export_type:'application_roster',program_id:'PRG-EXPORT-A'},attendance)).status,403);
    assert.equal((await request({export_type:'contact_roster',program_id:'PRG-EXPORT-A'},staff)).status,403);
    assert.equal((await request({export_type:'contact_roster',program_id:'PRG-EXPORT-A'},attendance)).status,403);
    assert.equal((await request({export_type:'application_roster',program_id:'PRG-EXPORT-A'},temporaryAdmin)).status,403);
    const bearerOnly=await exportPOST(new Request(origin+'/api/export/applications',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Authorization:'Bearer '+admin},body:JSON.stringify({export_type:'application_roster'})}));
    assert.equal(bearerOnly.status,401);
    assert.equal((await request({export_type:'application_roster'},staff)).status,403);
    assert.equal((await request({export_type:'application_roster',program_id:''},staff)).status,403);
    assert.equal((await request({export_type:'application_roster',program_id:null,run_id:null,program_name:'PRG-EXPORT-A',unknown_filter:'all'},staff)).status,403);
    assert.equal((await request({export_type:'contact_roster'},admin)).status,400);
    assert.equal((await request({export_type:'application_roster',program_id:'PRG-NOT-FOUND'},admin)).status,400);
    assert.equal((await request({export_type:'application_roster',run_id:'RUN-NOT-FOUND'},admin)).status,400);
    assert.equal((await request({export_type:'application_roster',program_id:'PRG-EXPORT-A',run_id:'RUN-EXPORT-B'},admin)).status,400);
    assert.equal((await request({export_type:'application_roster',program_id:'PRG-EXPORT-EMPTY'},admin)).status,404);

    const badOrigin=await exportPOST(new Request(origin+'/api/export/applications',{method:'POST',headers:{Origin:'http://evil.invalid','Content-Type':'application/json',Cookie:admin},body:JSON.stringify({export_type:'application_roster'})}));
    assert.equal(badOrigin.status,403);assert.doesNotMatch(badOrigin.headers.get('content-type')||'',/spreadsheetml/);
    const missingOrigin=await exportPOST(new Request(origin+'/api/export/applications',{method:'POST',headers:{'Content-Type':'application/json',Cookie:admin},body:JSON.stringify({export_type:'application_roster'})}));
    assert.equal(missingOrigin.status,403);
    const badContentType=await exportPOST(new Request(origin+'/api/export/applications',{method:'POST',headers:{Origin:origin,'Content-Type':'text/plain',Cookie:admin},body:JSON.stringify({export_type:'application_roster'})}));
    assert.equal(badContentType.status,415);
    const malformedAttendance=await exportPOST(new Request(origin+'/api/export/applications',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:attendance},body:'{'}));
    assert.equal(malformedAttendance.status,403);
    const malformedAdmin=await exportPOST(new Request(origin+'/api/export/applications',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',Cookie:admin},body:'{'}));
    assert.equal(malformedAdmin.status,400);

    const injectedAuditValues=[admin.split('=').slice(1).join('='),'010-9876-5432','sensitive memo text','C:/private/secret/database.sqlite'];
    for(const header of ['X-Forwarded-For','X-Real-IP'])for(const value of injectedAuditValues)await workbook(await request({export_type:'application_roster',program_id:'PRG-EXPORT-A'},admin,{[header]:value}));

    const audits=db.prepare("SELECT actor,entity_id,after_json,summary,before_json,reason,ip_address FROM audit_logs WHERE action='export_generated' ORDER BY id").all();
    assert.equal(audits.length,11);
    assert.deepEqual(audits.slice(0,3).map(row=>row.actor),['USR-EXPORT-ADMIN','USR-EXPORT-STAFF','USR-EXPORT-ADMIN']);
    assert.equal(audits.slice(3).every(row=>row.actor==='USR-EXPORT-ADMIN'),true);
    assert.equal(audits.every(row=>row.ip_address==='local'),true);
    const metadata=audits.map(row=>JSON.parse(row.after_json));
    assert.equal(metadata[0].export_type,'application_roster');assert.equal(metadata[0].row_count,5);
    assert.equal(metadata[1].program_id,'PRG-EXPORT-A');assert.equal(metadata[1].row_count,4);
    assert.equal(metadata[2].export_type,'contact_roster');assert.equal(metadata[2].row_count,4);
    const auditText=JSON.stringify(audits);
    for(const forbidden of people.flat().concat(injectedAuditValues,['절대 반출 금지 사유','검사 비밀 메모','만족도 비밀 의견']))assert.equal(auditText.includes(forbidden),false);

    db.exec("CREATE TEMP TRIGGER fail_export_audit BEFORE INSERT ON audit_logs WHEN NEW.action='export_generated' BEGIN SELECT RAISE(ABORT,'forced audit failure'); END");
    const auditFailure=await request({export_type:'application_roster',program_id:'PRG-EXPORT-A'},admin);
    assert.equal(auditFailure.status,500);assert.doesNotMatch(auditFailure.headers.get('content-type')||'',/spreadsheetml/);assert.equal(auditFailure.headers.get('content-disposition'),null);assert.equal((await auditFailure.json()).error,'internal_server_error');
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM audit_logs WHERE action='export_generated'").get().count,11);
    db.exec('DROP TRIGGER fail_export_audit');
    console.log(JSON.stringify({ok:true}));
  `;
  try{
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:projectRoot,env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:databasePath,ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'test-owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'테스트 관리자',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
    assert.deepEqual(JSON.parse(result.stdout.trim().split(/\r?\n/).at(-1)),{ok:true});
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('공식 신청 export는 client-side XLSX 생성 경로를 사용하지 않는다',()=>{
  const page=readFileSync(path.join(projectRoot,'app/page.tsx'),'utf8');
  assert.equal(page.includes("const exportExcel=async()=>{const X=await import('xlsx')"),false);
  assert.equal(page.includes('data.applications.map(a=>({관리번호'),false);
  assert.equal(page.includes("fetch('/api/export/applications'"),true);
  assert.equal(page.includes("eventType:'export"),false);
  assert.equal(page.includes("X.writeFile(wb,'신청자명단_양식.xlsx')"),true);
  assert.equal(page.includes("sheet_to_json<Record<string,unknown>>"),true);
});
