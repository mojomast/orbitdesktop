export interface FeatureReadiness {
  state: 'unknown' | 'missing_prerequisite';
  detail: string;
  prerequisites: {id:string;state:'present_unverified'|'missing_or_invalid'}[];
}
export interface FeatureObservation {observed_at:string;features:Record<string,FeatureReadiness>}
export interface FeatureCapability {
  feature_id:string;surface_uri:string;formats:string[];schema_ref:string|null;
  readiness:FeatureReadiness;execution_verified:boolean;
  open:{authority:string;effect:string};
  content:{authority:string;availability:string;verbs:string[]};
  delegated:{availability:string;channel:string};
}
export function featureCapabilities(options?:{audience?:string;observation?:FeatureObservation|null}):{
  version:number;generation:string;observed_at:string|null;
  freshness:{max_age_ms:number;revalidate_on_action:boolean};features:FeatureCapability[];
};
