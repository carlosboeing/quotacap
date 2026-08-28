export type Urgency = "burn now"|"use soon"|"slow down"|"save"|"on track";
export type BurnStatus = "at risk"|"on track";
export interface Advisory {
  provider:string;
  daysLeft:number;
  remaining:number;
  idealRate:number;
  burnRate:number;
  burnMeasured:boolean;
  daysToExhaust:number;
  status:BurnStatus;
  wastePct:number;
  urgency:Urgency;
}
