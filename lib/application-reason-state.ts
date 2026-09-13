export type ApplicationReasonResult={
  applicationId:number;
  reasonPresent:boolean;
  statusReason:string;
};

export function isApplicationReasonResponseCurrent(currentApplicationId:number|null,requestedApplicationId:number,responseApplicationId:number) {
  return currentApplicationId===requestedApplicationId&&responseApplicationId===requestedApplicationId;
}

export function updateApplicationReasonCache(current:Record<number,string>,result:ApplicationReasonResult) {
  const next={...current};
  if(result.reasonPresent)next[result.applicationId]=result.statusReason;
  else delete next[result.applicationId];
  return next;
}
