export type ScheduleCalendarView='month'|'week';
export type ScheduleRange={from:string;to:string};

function calendarDate(value:string) {
  const match=/^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if(!match)return undefined;
  const year=Number(match[1]),month=Number(match[2]),day=Number(match[3]);
  const date=new Date(0);
  date.setUTCHours(0,0,0,0);
  date.setUTCFullYear(year,month-1,day);
  if(date.getUTCFullYear()!==year||date.getUTCMonth()!==month-1||date.getUTCDate()!==day)return undefined;
  return date;
}

function dateKey(date:Date) {
  return `${String(date.getUTCFullYear()).padStart(4,'0')}-${String(date.getUTCMonth()+1).padStart(2,'0')}-${String(date.getUTCDate()).padStart(2,'0')}`;
}

export function isCanonicalCalendarDate(value:string) {
  return Boolean(calendarDate(value));
}

export function inclusiveCalendarDays(from:string,to:string) {
  const start=calendarDate(from),end=calendarDate(to);
  if(!start||!end)return Number.NaN;
  return Math.floor((end.getTime()-start.getTime())/86_400_000)+1;
}

export function visibleScheduleDateKeys(anchorDate:string,selectedDate:string,view:ScheduleCalendarView) {
  const anchor=calendarDate(anchorDate),selected=calendarDate(selectedDate);
  if(!anchor||!selected)return [];
  const basis=view==='week'?selected:new Date(anchor.getTime());
  if(view==='month')basis.setUTCDate(1);
  const start=new Date(basis.getTime());
  start.setUTCDate(basis.getUTCDate()-basis.getUTCDay());
  return Array.from({length:view==='month'?42:7},(_,index)=>{const date=new Date(start.getTime());date.setUTCDate(start.getUTCDate()+index);return dateKey(date)});
}

export function visibleScheduleRange(anchorDate:string,selectedDate:string,view:ScheduleCalendarView):ScheduleRange {
  const dates=visibleScheduleDateKeys(anchorDate,selectedDate,view);
  return {from:dates[0]||'',to:dates.at(-1)||''};
}

export function isScheduleResponseCurrent(current:ScheduleRange,requested:ScheduleRange,response:ScheduleRange) {
  return current.from===requested.from&&current.to===requested.to&&response.from===requested.from&&response.to===requested.to;
}

export function isScheduleDataReady(isStaff:boolean,scopeMatches:boolean,loading:boolean,fresh:boolean,error:string) {
  return !isStaff||(scopeMatches&&!loading&&fresh&&!error);
}
