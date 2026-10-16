// Group "viz" barrel: export every component of this group from its own file, one line each, e.g.
// `export { Name, type NameProps } from './Name';`. Only the viz group agent edits this file.
export { ArrowRow, type ArrowEnd, type ArrowRowProps } from './ArrowRow';
export { Chart, type ChartBar, type ChartProps } from './Chart';
export { ChartPatterns } from './ChartPatterns';
export {
  Checklist,
  ChecklistProgress,
  type ChecklistProgressProps,
  type ChecklistProps,
  type ChecklistQuickLink,
  type ChecklistStep,
} from './Checklist';
export {
  ConnectionsMap,
  type ConnectionsMapProps,
  type MapAccess,
  type MapConsumer,
  type MapToken,
} from './ConnectionsMap';
export { Delta, type DeltaProps } from './Delta';
export { Kpis, type KpiItem, type KpisProps } from './Kpis';
export { Legend, type LegendItem, type LegendMark, type LegendProps } from './Legend';
export {
  Matrix,
  type MatrixCell,
  type MatrixColumn,
  type MatrixGroup,
  type MatrixProps,
  type MatrixRow,
} from './Matrix';
export {
  NeedsAttention,
  type AttentionApprove,
  type AttentionItem,
  type AttentionLevel,
  type AttentionRole,
  type NeedsAttentionProps,
} from './NeedsAttention';
export { NextStep, type NextStepProps, type PrefillValue } from './NextStep';
export type { VizBrand, VizLogo } from './parts';
export {
  Pipeline,
  type PipelineDrop,
  type PipelineProps,
  type PipelineStage,
  type PipelineTotal,
} from './Pipeline';
export { ReasonBar, type Reason, type ReasonBarProps, type ReasonKind } from './ReasonBar';
export { SplitView, type SplitItem, type SplitViewProps } from './SplitView';
export { Trace, type TraceProps, type TraceState, type TraceStep } from './Trace';
