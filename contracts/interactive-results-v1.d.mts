/** Types for the executable, checked policy in interactive-results-v1.mjs. */
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type UserValue = string | number | boolean | string[];
export type AllowedComponent =
  | "Text"
  | "Card"
  | "Row"
  | "Column"
  | "Button"
  | "TextField"
  | "CheckBox"
  | "ChoicePicker"
  | "Slider"
  | "Divider"
  | "List"
  | "Tabs";
export interface DataBinding {
  path: string;
}
/** The official processor additionally checks each component's catalog schema. */
export interface A2uiComponent {
  id: string;
  component: AllowedComponent;
  text?: string | DataBinding;
  value?: DataBinding;
  child?: string;
  children?: string[];
  tabs?: Array<{ child: string; title?: string | DataBinding }>;
  action?: {
    event: { name: "prepare_summary"; context?: Record<string, JsonValue> };
  };
  [property: string]: unknown;
}
export type A2uiMessage =
  | {
      version: "v0.9";
      createSurface: { surfaceId: string; catalogId: typeof CATALOG_ID };
    }
  | {
      version: "v0.9";
      updateComponents: { surfaceId: string; components: A2uiComponent[] };
    }
  | {
      version: "v0.9";
      updateDataModel: { surfaceId: string; path?: string; value?: JsonValue };
    };
export interface ResultValidation {
  surfaceId: string;
  components: Map<string, A2uiComponent>;
  bindings: Set<string>;
}
export const CATALOG_ID: "https://a2ui.org/specification/v0_9/catalogs/basic/catalog.json";
export const ALLOWED_COMPONENTS: readonly AllowedComponent[];
export const LIMITS: Readonly<{
  bytes: 262144;
  messages: 256;
  nodes: 2000;
  depth: 32;
  string: 16384;
  documents: 128;
  receipts: 4096;
}>;
export function fail(code: string, message: string, path?: string): never;
export function canonical(value: unknown): string | undefined;
export function exact(
  value: unknown,
  required: readonly string[],
  optional?: readonly string[],
): asserts value is Record<string, unknown>;
export function pointer(value: unknown): string;
/** Runtime admission accepts unknown JSON and throws a code/path diagnostic on failure. */
export function validateResult(
  messages: unknown,
  userValues?: unknown,
): ResultValidation;
export function parseMessages(text: unknown): A2uiMessage[];
