export type Urgency = "burn now"|"use soon"|"slow down"|"save"|"on track";
export type BurnStatus = "at risk"|"on track"|"unknown";
export interface Advisory {
  provider:string;
  daysLeft:number;
  remaining:number;
  idealRate:number;
  burnRate:number | null;
  burnMeasured:boolean;
  daysToExhaust:number | null;
  status:BurnStatus;
  wastePct:number | null;
  urgency:Urgency;
}
