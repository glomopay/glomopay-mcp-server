export const TOOL_NAMES = [
  'glomo_api_read',
  'glomo_api_write',
  'glomo_api_search',
  'glomo_api_details',
  'glomo_docs_search',
  'glomo_sample_request',
  'glomo_implementation_planner',
] as const;

export type TToolName = (typeof TOOL_NAMES)[number];
