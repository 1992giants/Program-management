import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

test('Sprint 2 Beta E preserves phone identity and historical assessment scores',()=>{
  const dir=mkdtempSync(path.join(tmpdir(),'sprint-2-e-'));
  try{
    const db=path.join(dir,'test.sqlite');
    const source=String.raw`
      import assert from 'node:assert/strict';
      import {POST,GET} from './app/api/data/route.ts';
      import {getDatabase,hashPin} from './db/index.ts';
      const d=getDatabase(),origin='http://localhost:3000',day='2026-09-18';
      d.prepare('INSERT INTO staff_users (id,username,display_name,pin_hash,role,active,created_at,must_change_pin) VALUES (?,?,?,?,?,1,?,0)').run('U','e','E',hashPin('e','86420975'),'관리자',day);
      d.prepare('INSERT INTO programs (id,name,category,delivery_type,session_count,recurrence,location,manager,capacity,status,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run('P','P','x','x',1,'x','x','x',20,'운영 중',day);
      d.prepare('INSERT INTO program_runs (id,program_id,round_number,label,start_date,status) VALUES (?,?,?,?,?,?)').run('R','P',1,'R',day,'진행 중');
      d.prepare('INSERT INTO assessment_catalog (id,name,min_score,max_score,active,created_at) VALUES (?,?,?,?,?,?)').run('X','현재',0,10,1,day);d.prepare('INSERT INTO assessment_catalog (id,name,min_score,max_score,active,created_at) VALUES (?,?,?,?,?,?)').run('Y','과거',0,10,1,day);d.prepare('INSERT INTO assessment_catalog (id,name,min_score,max_score,active,created_at) VALUES (?,?,?,?,?,?)').run('Z','미사용',0,10,0,day);
      d.prepare('INSERT INTO program_assessments (program_id,assessment_id,sort_order) VALUES (?,?,?),(?,?,?)').run('P','X',0,'P','Y',1);
      d.prepare("INSERT INTO participants (id,name,gender,age,phone,member_status,note,created_at) VALUES (?,?,?,?,?,'비회원','',?)").run('A','홍길동','x',0,'010.1234.5678',day);d.prepare('INSERT INTO applications (id,participant_id,program_id,run_id,applied_at,status,queue_number) VALUES (?,?,?,?,?,?,?)').run(1,'A','P','R',day,'참가중',1);d.prepare('INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at) VALUES (?,?,?,?,?,?)').run(1,'X',1,2,'',day);d.prepare('INSERT INTO assessment_scores (application_id,assessment_id,pre_score,post_score,note,updated_at) VALUES (?,?,?,?,?,?)').run(1,'Y',3,4,'',day);
      const post=(body,c='')=>POST(new Request(origin+'/api/data',{method:'POST',headers:{Origin:origin,'Content-Type':'application/json',...(c?{Cookie:c}:{})},body:JSON.stringify(body)}));const login=await post({action:'login',username:'e',pin:'86420975'}),cookie=login.headers.get('set-cookie').split(';')[0];
      let r=await post({action:'import',programId:'P',rows:[{name:'홍길동',phone:'010-1234-5678'},{name:'동일',phone:'010 5555 6666'},{name:'동일',phone:'010.5555.6666'},{name:'홍길동',phone:'010-1234-9999'}]},cookie),b=await r.json();assert.equal(r.status,200);assert.equal(b.importResult.createdParticipants,2);assert.equal(b.importResult.existingParticipants,2);assert.equal(d.prepare('SELECT COUNT(*) n FROM participants WHERE name=?').get('홍길동').n,2);assert.equal(d.prepare('SELECT COUNT(*) n FROM participants WHERE name=?').get('동일').n,1);
      assert.equal((await post({action:'setAssessmentActive',id:'Y',active:false},cookie)).status,200);assert.equal((await post({action:'setProgramAssessments',programId:'P',assessmentIds:['X']},cookie)).status,200);
      r=await GET(new Request(origin+'/api/data?resource=outcomes&programId=P&runId=R',{headers:{Cookie:cookie}}));b=await r.json();assert.deepEqual(b.assessmentScores.map(x=>x.assessment_id).sort(),['X','Y']);assert.equal((await post({action:'saveAssessmentScore',applicationId:1,assessmentId:'Y',preScore:9,postScore:9,note:'',preDate:day,postDate:day,notCompletedReason:'',programId:'P',runId:'R'},cookie)).status,400);console.log(JSON.stringify({ok:true}));
    `;
    const result=spawnSync(process.execPath,['--input-type=module','--eval',source],{cwd:path.resolve(import.meta.dirname,'..'),env:{...process.env,NODE_ENV:'test',ONMAEUM_TEST_DB_PATH:db,ONMAEUM_BACKUP_DIR:path.join(dir,'backups'),ONMAEUM_BOOTSTRAP_ADMIN_USERNAME:'owner',ONMAEUM_BOOTSTRAP_ADMIN_DISPLAY_NAME:'owner',ONMAEUM_BOOTSTRAP_ADMIN_PIN:'97531086',ONMAEUM_ENABLE_DEMO_SEED:'0'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr||result.stdout);
  }finally{rmSync(dir,{recursive:true,force:true});}
});