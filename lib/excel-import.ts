export function formatExcelApplicationDate(value:unknown){
  if(value instanceof Date&&!Number.isNaN(value.getTime()))return `${value.getUTCFullYear()}-${String(value.getUTCMonth()+1).padStart(2,'0')}-${String(value.getUTCDate()).padStart(2,'0')}`;
  if(typeof value==='number'&&Number.isFinite(value)&&value>0&&value<100000)return new Date(Math.round((value-25569)*86400000)).toISOString().slice(0,10);
  return String(value??'').trim();
}