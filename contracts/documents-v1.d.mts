export const DOCUMENT_LIMITS:Readonly<{richtext:number;scene:number;documents:number;receipts:number;depth:number;nodes:number}>;
export const DOCUMENT_UUID:string;
export const CANVAS_FONT_IDS:readonly number[];
export const CANVAS_FONT_FAMILIES:readonly string[];
export const CANVAS_FONT_POLICY_KEY:string;
export const documentsRequestSchema:object;
export const EMPTY_RICHDOC:string;
export const EMPTY_CANVAS:string;
export function validateDocumentData(data:unknown):any;
