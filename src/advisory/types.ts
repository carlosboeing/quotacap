export type Urgency = "burn now"|"use soon"|"slow down"|"save"|"on track";
export interface Advisory { provider:string; daysLeft:number; remaining:number; idealRate:number; burnRate:number; wastePct:number; urgency:Urgency; }
