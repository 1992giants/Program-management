'use client';

import { useMemo, useState } from 'react';

type ParticipantOption = { id:string; name:string; phone:string };
type CalendarSessionRecord = {
  id:string;
  program_name:string;
  run_label:string;
  session_number:number;
  session_date:string;
  session_time:string;
  location:string;
};
export type CalendarEventRecord = {
  id:string;
  event_type:string;
  color:string;
  participant_id:string;
  participant_name:string;
  title:string;
  event_date:string;
  all_day:number;
  start_time:string;
  end_time:string;
  recurrence:string;
  delivery_mode:string;
};
export type ScheduleCreateInput = {
  eventType:string;
  color:string;
  participantId:string;
  title:string;
  eventDate:string;
  allDay:boolean;
  startTime:string;
  endTime:string;
  recurrence:string;
  deliveryMode:string;
};

type CalendarItem = {
  id:string;
  title:string;
  time:string;
  color:string;
  meta:string;
  kind:'session'|'custom';
};

const WEEKDAYS=['일','월','화','수','목','금','토'];
const COLORS=[
  {value:'green',label:'그린'},
  {value:'orange',label:'오렌지'},
  {value:'blue',label:'블루'},
  {value:'purple',label:'퍼플'},
  {value:'gray',label:'그레이'},
];
const HOLIDAYS:Record<string,string>={
  '2026-01-01':'신정','2026-02-16':'설날 연휴','2026-02-17':'설날','2026-02-18':'설날 연휴',
  '2026-03-01':'삼일절','2026-03-02':'대체공휴일','2026-05-05':'어린이날','2026-05-24':'부처님오신날',
  '2026-05-25':'대체공휴일','2026-06-06':'현충일','2026-08-15':'광복절','2026-08-17':'대체공휴일',
  '2026-09-24':'추석 연휴','2026-09-25':'추석','2026-09-26':'추석 연휴','2026-10-03':'개천절',
  '2026-10-05':'대체공휴일','2026-10-09':'한글날','2026-12-25':'성탄절',
};

function dateKey(date:Date){return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`}
function dateFromKey(value:string){const [year,month,day]=value.split('-').map(Number);return new Date(year,month-1,day)}
function todayKey(){return new Date().toLocaleDateString('sv-SE',{timeZone:'Asia/Seoul'})}

export function CalendarHeader({anchor,view,onMove,onToday,onView,onOpenDrawer,drawerOpen}:{anchor:Date;view:'month'|'week';onMove:(amount:number)=>void;onToday:()=>void;onView:(view:'month'|'week')=>void;onOpenDrawer:()=>void;drawerOpen:boolean}){
  return <header className="schedule-calendar-header">
    <div className="calendar-month-navigation">
      <button className="calendar-arrow" onClick={()=>onMove(-1)} aria-label={view==='month'?'이전 달':'이전 주'}>‹</button>
      <strong>{anchor.getFullYear()}.{String(anchor.getMonth()+1).padStart(2,'0')}</strong>
      <button className="calendar-arrow" onClick={()=>onMove(1)} aria-label={view==='month'?'다음 달':'다음 주'}>›</button>
      <button className="calendar-today-button" onClick={onToday}>오늘</button>
    </div>
    <div className="calendar-header-actions">
      {!drawerOpen&&<button className="calendar-add-button" onClick={onOpenDrawer}>＋ 일정 추가</button>}
      <div className="calendar-view-switch" role="group" aria-label="달력 보기 방식">
        <button className={view==='week'?'active':''} onClick={()=>onView('week')}>주간</button>
        <button className={view==='month'?'active':''} onClick={()=>onView('month')}>월간</button>
      </div>
    </div>
  </header>;
}

export function ScheduleEvent({item,holiday}:{item?:CalendarItem;holiday?:string}){
  if(holiday)return <span className="schedule-event holiday"><span>{holiday}</span></span>;
  if(!item)return null;
  return <button type="button" className={`schedule-event ${item.color}`} title={`${item.title} · ${item.meta}`}>
    {item.time&&<b>{item.time}</b>}<span>{item.title}</span>
  </button>;
}

export function CalendarCell({date,currentMonth,selected,items,holiday,onSelect}:{date:Date;currentMonth:number;selected:boolean;items:CalendarItem[];holiday?:string;onSelect:(value:string)=>void}){
  const key=dateKey(date),day=date.getDay(),outside=date.getMonth()!==currentMonth;
  return <div className={`monthly-calendar-cell ${outside?'outside':''} ${selected?'selected':''} ${day===0?'sunday':''} ${day===6?'saturday':''}`} onClick={()=>onSelect(key)}>
    <button type="button" className="calendar-date-button" onClick={()=>onSelect(key)} aria-label={`${key} 선택`}><span>{date.getDate()}</span></button>
    <div className="calendar-cell-events">
      {holiday&&<ScheduleEvent holiday={holiday}/>}
      {items.slice(0,holiday?2:3).map(item=><ScheduleEvent key={`${item.kind}-${item.id}`} item={item}/>)}
      {items.length>(holiday?2:3)&&<span className="calendar-more">+{items.length-(holiday?2:3)}개 더보기</span>}
    </div>
  </div>;
}

export function MonthlyCalendar({anchor,selectedDate,view,itemsByDate,onSelect}:{anchor:Date;selectedDate:string;view:'month'|'week';itemsByDate:Map<string,CalendarItem[]>;onSelect:(date:string)=>void}){
  const dates=useMemo(()=>{
    if(view==='week'){
      const selected=dateFromKey(selectedDate),start=new Date(selected);start.setDate(selected.getDate()-selected.getDay());
      return Array.from({length:7},(_,index)=>{const date=new Date(start);date.setDate(start.getDate()+index);return date});
    }
    const first=new Date(anchor.getFullYear(),anchor.getMonth(),1),start=new Date(first);start.setDate(1-first.getDay());
    return Array.from({length:42},(_,index)=>{const date=new Date(start);date.setDate(start.getDate()+index);return date});
  },[anchor,selectedDate,view]);
  return <section className={`monthly-calendar ${view==='week'?'weekly':''}`}>
    <div className="monthly-calendar-weekdays">{WEEKDAYS.map((weekday,index)=><b className={index===0?'sunday':index===6?'saturday':''} key={weekday}>{weekday}</b>)}</div>
    <div className="monthly-calendar-grid">{dates.map(date=>{const key=dateKey(date);return <CalendarCell key={key} date={date} currentMonth={anchor.getMonth()} selected={key===selectedDate} items={itemsByDate.get(key)||[]} holiday={HOLIDAYS[key]} onSelect={onSelect}/>})}</div>
  </section>;
}

function timeOptions(){const values:string[]=[];for(let hour=7;hour<=21;hour+=1)for(const minute of ['00','30'])values.push(`${String(hour).padStart(2,'0')}:${minute}`);return values}

export function ScheduleCreateDrawer({participants,selectedDate,onClose,onCreate}:{participants:ParticipantOption[];selectedDate:string;onClose:()=>void;onCreate:(input:ScheduleCreateInput)=>Promise<void>}){
  const [eventType,setEventType]=useState('상담'),[color,setColor]=useState('green'),[participantId,setParticipantId]=useState(''),[title,setTitle]=useState(''),[eventDate,setEventDate]=useState(selectedDate),[allDay,setAllDay]=useState(false),[startTime,setStartTime]=useState('11:00'),[endTime,setEndTime]=useState('12:00'),[recurrence,setRecurrence]=useState('1회'),[deliveryMode,setDeliveryMode]=useState('대면'),[saving,setSaving]=useState(false);
  const valid=Boolean(participantId&&title.trim()&&eventDate&&(allDay||(startTime&&endTime&&endTime>startTime)));
  const submit=async()=>{if(!valid||saving)return;setSaving(true);try{await onCreate({eventType,color,participantId,title:title.trim(),eventDate,allDay,startTime,endTime,recurrence,deliveryMode});setTitle('');setParticipantId('')}finally{setSaving(false)}};
  return <aside className={`schedule-create-drawer ${eventType==='상담'?'counseling':''}`} aria-label="일정 추가하기">
    <div className="schedule-drawer-head"><div><span>NEW SCHEDULE</span><h2>일정 추가하기</h2></div><button onClick={onClose} aria-label="일정 추가 닫기">×</button></div>
    <div className="schedule-drawer-scroll">
      <section className="schedule-form-section">
        <label className="schedule-field-label">프로그램 종류</label>
        <div className="schedule-type-options">{['상담','프로그램','기타'].map(type=><button key={type} className={eventType===type?'active':''} onClick={()=>{setEventType(type);if(type==='상담')setColor('green')}}>{type}</button>)}</div>
      </section>
      <section className="schedule-form-section">
        <label className="schedule-field-label">색상 선택</label>
        <div className="schedule-color-options">{COLORS.map(item=><button key={item.value} className={`${item.value} ${color===item.value?'active':''}`} onClick={()=>setColor(item.value)} aria-label={`${item.label} 선택`}><span/></button>)}</div>
      </section>
      <label className="schedule-form-field"><span>참가자 선택 <b>*</b></span><select value={participantId} onChange={event=>setParticipantId(event.target.value)}><option value="">참가자를 선택하세요</option>{participants.map(participant=><option key={participant.id} value={participant.id}>{participant.name} · {participant.phone}</option>)}</select></label>
      <label className="schedule-form-field"><span>일정 제목 <b>*</b></span><input value={title} onChange={event=>setTitle(event.target.value)} placeholder="예: 김민준 초기상담"/></label>
      <div className="schedule-divider"/>
      <label className="schedule-form-field"><span>날짜 <b>*</b></span><input type="date" value={eventDate} onChange={event=>setEventDate(event.target.value)}/></label>
      <div className="schedule-toggle-row"><span><b>하루 종일</b><small>시간을 지정하지 않는 일정</small></span><button type="button" role="switch" aria-checked={allDay} className={allDay?'active':''} onClick={()=>setAllDay(value=>!value)}><i/></button></div>
      <div className={`schedule-time-grid ${allDay?'disabled':''}`}>
        <label className="schedule-form-field"><span>시작시간</span><select disabled={allDay} value={startTime} onChange={event=>setStartTime(event.target.value)}>{timeOptions().map(time=><option key={time}>{time}</option>)}</select></label>
        <label className="schedule-form-field"><span>종료시간</span><select disabled={allDay} value={endTime} onChange={event=>setEndTime(event.target.value)}>{timeOptions().map(time=><option key={time}>{time}</option>)}</select></label>
      </div>
      {!allDay&&endTime<=startTime&&<p className="schedule-field-error">종료시간은 시작시간보다 늦어야 합니다.</p>}
      <label className="schedule-form-field"><span>프로그램 주기</span><select value={recurrence} onChange={event=>setRecurrence(event.target.value)}><option>1회</option><option>매주</option><option>격주</option><option>매월</option></select></label>
      <label className="schedule-form-field"><span>프로그램 방식</span><select value={deliveryMode} onChange={event=>setDeliveryMode(event.target.value)}><option>대면</option><option>비대면</option><option>전화</option><option>가정방문</option></select></label>
    </div>
    <footer className="schedule-drawer-footer"><button disabled={!valid||saving} onClick={submit}>{saving?'저장 중...':'일정 추가하기'}</button></footer>
  </aside>;
}

export default function ScheduleCalendar({participants,sessions,scheduleEvents,canEdit=true,onCreate}:{participants:ParticipantOption[];sessions:CalendarSessionRecord[];scheduleEvents:CalendarEventRecord[];canEdit?:boolean;onCreate:(input:ScheduleCreateInput)=>Promise<void>}){
  const initial=todayKey(),[selectedDate,setSelectedDate]=useState(initial),[anchor,setAnchor]=useState(()=>dateFromKey(initial)),[view,setView]=useState<'month'|'week'>('month'),[drawerOpen,setDrawerOpen]=useState(canEdit);
  const itemsByDate=useMemo(()=>{
    const map=new Map<string,CalendarItem[]>(),add=(key:string,item:CalendarItem)=>map.set(key,[...(map.get(key)||[]),item]);
    sessions.forEach(session=>add(session.session_date,{id:session.id,title:session.program_name,time:session.session_time.slice(0,5),color:'blue',meta:`${session.run_label} · ${session.session_number}회기 · ${session.location}`,kind:'session'}));
    scheduleEvents.forEach(event=>add(event.event_date,{id:event.id,title:event.title,time:event.all_day?'':event.start_time.slice(0,5),color:event.color,meta:`${event.participant_name} · ${event.event_type} · ${event.delivery_mode}`,kind:'custom'}));
    for(const list of map.values())list.sort((a,b)=>(a.time||'00:00').localeCompare(b.time||'00:00'));
    return map;
  },[sessions,scheduleEvents]);
  const selectDate=(value:string)=>{setSelectedDate(value);setAnchor(dateFromKey(value))};
  const move=(amount:number)=>{const next=new Date(anchor);if(view==='month')next.setMonth(next.getMonth()+amount,1);else next.setDate(next.getDate()+amount*7);setAnchor(next);if(view==='week')setSelectedDate(dateKey(next))};
  const goToday=()=>{const value=todayKey();setSelectedDate(value);setAnchor(dateFromKey(value))};
  return <div className={`calendar-workspace ${drawerOpen?'with-drawer':''}`}>
    <div className="calendar-main-panel">
      <CalendarHeader anchor={anchor} view={view} onMove={move} onToday={goToday} onView={setView} onOpenDrawer={()=>setDrawerOpen(true)} drawerOpen={drawerOpen}/>
      <MonthlyCalendar anchor={anchor} selectedDate={selectedDate} view={view} itemsByDate={itemsByDate} onSelect={selectDate}/>
    </div>
    {drawerOpen&&canEdit&&<ScheduleCreateDrawer key={selectedDate} participants={participants} selectedDate={selectedDate} onClose={()=>setDrawerOpen(false)} onCreate={onCreate}/>}
  </div>;
}
