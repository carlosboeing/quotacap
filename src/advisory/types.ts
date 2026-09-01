export type Urgency = "burn now"|"use soon"|"slow down"|"save"|"on track";
export type BurnStatus = "at risk"|"on track"|"unknown";
export type PaceSource = "recent"|"window-average"|"unknown";
export type RecommendationBasis = "known-waste"|"unknown-headroom"|"none";

export interface Advisory {
  provider:string;
  daysLeft:number;
  remaining:number;
  idealRate:number;
  burnRate:number | null;
  burnMeasured:boolean;
  paceSource:PaceSource;
  daysToExhaust:number | null;
  status:BurnStatus;
  wastePct:number | null;
  urgency:Urgency;
}

export interface Recommendation {
  use: string;
  reason: string;
  wastePct: number | null;
  idealRate: number;
  recommendationBasis: RecommendationBasis;
  alternatives: any[];
  advisories: Advisory[];
}
