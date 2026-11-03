/** Keep planned tools visible to contributors without advertising them to models. */
export const TOOL_CATALOG = [
  { name: 'sapper_status', milestone: 'M0', implemented: true },
  { name: 'sapper_init', milestone: 'M1', implemented: true },
  { name: 'sapper_fact', milestone: 'M1', implemented: true },
  { name: 'sapper_intent', milestone: 'M1', implemented: true },
  { name: 'sapper_doc', milestone: 'M1', implemented: true },
  { name: 'sapper_flag', milestone: 'M1', implemented: true },
  { name: 'sapper_recall', milestone: 'M2', implemented: true },
  { name: 'sapper_dispatch', milestone: 'M3', implemented: false },
  { name: 'sapper_kb', milestone: 'M2', implemented: true },
] as const
