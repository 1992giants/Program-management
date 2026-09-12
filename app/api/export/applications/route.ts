import * as XLSX from 'xlsx';
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { getDatabase } from '../../../../db/index.ts';
import { expiredSessionCookie, getAuthenticatedUser, validateMutationRequest } from '../../../../lib/security.ts';

export const runtime='nodejs';
export const dynamic='force-dynamic';

const XLSX_CONTENT_TYPE='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const APPLICATION_STATUSES=new Set(['신청','선정검토','참가대기','참가중','참가완료','중도탈락','취소']);
type ExportType='application_roster'|'contact_roster';
type ExportRow=Record<string,string|number|null>;

class ExportError extends Error { status:number;constructor(message:string,status=400){super(message);this.status=status} }

function noStore(response:Response){response.headers.set('Cache-Control','no-store');return response}
function jsonError(message:string,status:number,loginRequired=false){const response=Response.json({error:message,...(loginRequired?{loginRequired:true}:{})},{status});if(loginRequired)response.headers.append('Set-Cookie',expiredSessionCookie());return noStore(response)}
function requestIp(request:Request){void request;return 'local'}
function text(value:unknown){return String(value??'').trim()}
function safeExcelValue(value:string|number|null){return typeof value==='string'&&/^[=+\-@]/.test(value)?`'${value}`:value}
function safeRows(rows:ExportRow[]){return rows.map(row=>Object.fromEntries(Object.entries(row).map(([key,value])=>[key,safeExcelValue(value)])) as ExportRow)}

function resolveScope(db:DatabaseSync,programInput:string,runInput:string){
  let programId='';
  let runId='';
  if(programInput){const program=db.prepare('SELECT id FROM programs WHERE id=?').get(programInput) as {id:string}|undefined;if(!program)throw new ExportError('프로그램을 찾을 수 없습니다.');programId=program.id}
  if(runInput){const run=db.prepare('SELECT id,program_id FROM program_runs WHERE id=?').get(runInput) as {id:string;program_id:string}|undefined;if(!run)throw new ExportError('차수를 찾을 수 없습니다.');if(programId&&run.program_id!==programId)throw new ExportError('선택한 차수가 해당 프로그램에 속하지 않습니다.');runId=run.id;programId=programId||run.program_id}
  return {programId,runId};
}

function exportRows(db:DatabaseSync,exportType:ExportType,programId:string,runId:string,status:string){
  const where:string[]=[];
  const params:SQLInputValue[]=[];
  if(programId){where.push('a.program_id=?');params.push(programId)}
  if(runId){where.push('a.run_id=?');params.push(runId)}
  if(status){where.push('a.status=?');params.push(status)}
  const filter=where.length?` WHERE ${where.join(' AND ')}`:'';
  if(exportType==='application_roster')return db.prepare(`SELECT p.id AS '관리번호',p.name AS '이름',pr.name AS '프로그램',COALESCE(r.label,'차수 미배정') AS '차수',a.applied_at AS '신청일',a.status AS '신청상태',a.queue_number AS '대기순번' FROM applications a JOIN participants p ON p.id=a.participant_id JOIN programs pr ON pr.id=a.program_id LEFT JOIN program_runs r ON r.id=a.run_id${filter} ORDER BY a.applied_at,a.id`).all(...params) as ExportRow[];
  return db.prepare(`SELECT p.id AS '관리번호',p.name AS '이름',p.phone AS '연락처',pr.name AS '프로그램',COALESCE(r.label,'차수 미배정') AS '차수',a.status AS '신청상태' FROM applications a JOIN participants p ON p.id=a.participant_id JOIN programs pr ON pr.id=a.program_id LEFT JOIN program_runs r ON r.id=a.run_id${filter} ORDER BY a.applied_at,a.id`).all(...params) as ExportRow[];
}

function workbookBytes(exportType:ExportType,rows:ExportRow[]){
  const worksheet=XLSX.utils.json_to_sheet(safeRows(rows));
  const workbook=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook,worksheet,exportType==='application_roster'?'신청운영명단':'연락용명단');
  return Uint8Array.from(XLSX.write(workbook,{bookType:'xlsx',type:'buffer'}) as Uint8Array);
}

function recordExport(db:DatabaseSync,userId:string,exportType:ExportType,programId:string,runId:string,status:string,rowCount:number,request:Request){
  const metadata={export_type:exportType,program_id:programId||null,run_id:runId||null,status_filter:status||null,row_count:rowCount,exported_column_categories:exportType==='application_roster'?['participant_identifier','program_application']:['participant_identifier','contact','program_application']};
  db.prepare('INSERT INTO audit_logs (created_at,actor,action,entity_type,entity_id,before_json,after_json,summary,reason,ip_address) VALUES (?,?,?,?,?,?,?,?,?,?)').run(new Date().toLocaleString('sv-SE',{timeZone:'Asia/Seoul'}),userId,'export_generated','export',exportType,'',JSON.stringify(metadata),'Excel export generated / response issued','',requestIp(request));
}

async function handlePOST(request:Request){
  try{
    const requestError=validateMutationRequest(request);
    if(requestError)return jsonError(requestError.error,requestError.status);
    const db=getDatabase();
    const user=getAuthenticatedUser(request,db);
    if(!user)return jsonError('로그인이 필요합니다.',401,true);
    if(user.must_change_pin)return jsonError('관리자가 발급한 임시 PIN을 먼저 변경하세요.',403);
    if(!['관리자','일반 담당자'].includes(user.role))return jsonError('이 내보내기를 사용할 권한이 없습니다.',403);
    let parsed:unknown;
    try{parsed=await request.json()}catch{throw new ExportError('올바른 JSON 요청을 전송하세요.')}
    if(!parsed||typeof parsed!=='object'||Array.isArray(parsed))throw new ExportError('올바른 JSON 요청을 전송하세요.');
    const body=parsed as Record<string,unknown>;
    const exportType=text(body.export_type) as ExportType;
    if(!['application_roster','contact_roster'].includes(exportType))throw new ExportError('지원하지 않는 내보내기 종류입니다.');
    if(exportType==='application_roster'&&!['관리자','일반 담당자'].includes(user.role))return jsonError('이 내보내기를 사용할 권한이 없습니다.',403);
    if(exportType==='contact_roster'&&user.role!=='관리자')return jsonError('관리자만 연락용 명단을 내보낼 수 있습니다.',403);
    const {programId,runId}=resolveScope(db,text(body.program_id),text(body.run_id));
    if(exportType==='application_roster'&&user.role==='일반 담당자'&&!programId&&!runId)return jsonError('일반 담당자는 프로그램 또는 차수 범위를 선택해야 합니다.',403);
    if(exportType==='contact_roster'&&!programId&&!runId)throw new ExportError('연락용 명단은 프로그램 또는 차수 범위를 선택해야 합니다.');
    const status=text(body.status);
    if(status&&!APPLICATION_STATUSES.has(status))throw new ExportError('올바른 신청 상태를 선택하세요.');
    const rows=exportRows(db,exportType,programId,runId,status);
    if(!rows.length)throw new ExportError('선택한 범위에 내보낼 신청자가 없습니다.',404);
    const bytes=workbookBytes(exportType,rows);
    recordExport(db,user.id,exportType,programId,runId,status,rows.length,request);
    const date=new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'}),filename=`${exportType==='application_roster'?'신청운영명단':'연락용명단'}_${date}.xlsx`;
    return noStore(new Response(bytes.buffer,{status:200,headers:{'Content-Type':XLSX_CONTENT_TYPE,'Content-Disposition':`attachment; filename*=UTF-8''${encodeURIComponent(filename)}`,'X-Content-Type-Options':'nosniff'}}));
  }catch(error){
    if(error instanceof ExportError)return jsonError(error.message,error.status);
    console.error('[api/export/applications] internal error',error);
    return jsonError('internal_server_error',500);
  }
}

export async function POST(request:Request){return handlePOST(request)}
