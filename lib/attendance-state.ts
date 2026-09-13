export function isAttendanceDetailReady(isStaff:boolean,scopeMatches:boolean,loading:boolean,fresh:boolean,error:string) {
  return !isStaff||(scopeMatches&&!loading&&fresh&&!error);
}

export function isAttendanceResponseCurrent(currentSessionId:string,currentRunId:string,requestedSessionId:string,requestedRunId:string,responseSessionId:string,responseRunId:string) {
  return currentSessionId===requestedSessionId&&currentRunId===requestedRunId&&responseSessionId===requestedSessionId&&responseRunId===requestedRunId;
}
