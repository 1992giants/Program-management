export function isOutcomeEditorEnabled(isStaff:boolean,scopeMatches:boolean,loading:boolean,fresh:boolean,error:string) {
  return !isStaff||(scopeMatches&&!loading&&fresh&&!error);
}
