/**
 * Shared data shapes for the Janitor.
 *
 * Everything here is plain data (no behaviour). Collectors produce these
 * shapes, the rules engine reads them, and nothing in this file knows about
 * AWS SDKs, HTTP or databases.
 */

export type ResourceType = 'ebs_volume' | 'ec2_instance' | 'ebs_snapshot' | 'elastic_ip';

interface ResourceBase {
  /** Cloud identifier, for example vol-0abc... */
  id: string;
  type: ResourceType;
  region: string;
  accountId: string;
  /** Tags exactly as found on the resource. */
  tags: Record<string, string>;
}

export interface VolumeResource extends ResourceBase {
  type: 'ebs_volume';
  /** AWS volume state: available means "not attached to anything". */
  state: string;
  sizeGb: number;
  /** gp3, gp2, io1, io2, st1, sc1, standard ... */
  volumeType: string;
}

/** Summary of CloudWatch metrics over a window of whole days. */
export interface InstanceMetrics {
  windowDays: number;
  avgCpuPercent: number;
  /** Average of (network in + network out) per day, in bytes. */
  avgNetworkBytesPerDay: number;
}

export interface InstanceResource extends ResourceBase {
  type: 'ec2_instance';
  /** running, stopped, pending ... */
  state: string;
  instanceType: string;
  /** null means metrics could not be collected. The rules never guess. */
  metrics: InstanceMetrics | null;
}

export interface SnapshotResource extends ResourceBase {
  type: 'ebs_snapshot';
  sizeGb: number;
  /** ISO 8601 timestamp of when the snapshot was started. */
  startTime: string;
  /** True when a machine image (AMI) still references this snapshot. */
  usedByImage: boolean;
}

export interface ElasticIpResource extends ResourceBase {
  type: 'elastic_ip';
  publicIp: string;
  /** True when attached to an instance or network interface. */
  associated: boolean;
}

export type Resource = VolumeResource | InstanceResource | SnapshotResource | ElasticIpResource;

/** One sighting of a resource's state, recorded by the Janitor on each run. */
export interface Observation {
  /** ISO 8601 timestamp. */
  observedAt: string;
  state: string;
}

/** Observation history keyed by resource id. */
export type ObservationHistory = Record<string, Observation[]>;

/** Thresholds the rules use. All configurable, see config module. */
export interface RuleConfig {
  unattachedDiskDays: number;
  idleWindowDays: number;
  idleCpuPercent: number;
  idleNetworkBytesPerDay: number;
  snapshotMaxAgeDays: number;
}

export interface RuleContext {
  now: Date;
  config: RuleConfig;
  history: ObservationHistory;
}

export type EvidenceValue = string | number | boolean;

export type RuleOutcome =
  | { kind: 'finding'; ruleId: string; reason: string; evidence: Record<string, EvidenceValue> }
  | { kind: 'no_finding' }
  | { kind: 'insufficient_data'; ruleId: string; reason: string };

export interface Rule {
  readonly id: string;
  readonly appliesTo: ResourceType;
  evaluate(resource: Resource, ctx: RuleContext): RuleOutcome;
}

export type CostEstimate =
  | { ok: true; monthlyUsd: number; basis: string }
  | { ok: false; reason: string };

export interface Finding {
  /** Stable id: ruleId plus resource id. The same problem keeps the same id between runs. */
  id: string;
  ruleId: string;
  resourceId: string;
  resourceType: ResourceType;
  region: string;
  reason: string;
  evidence: Record<string, EvidenceValue>;
  estimate: CostEstimate;
  detectedAt: string;
}

export interface SkippedResource {
  resourceId: string;
  ruleId: string;
  reason: string;
}

export interface InvalidResource {
  /** Best-effort id (or "unknown") of the malformed input. */
  resourceId: string;
  reason: string;
}

export interface EvaluationReport {
  generatedAt: string;
  /** Everything handed to the evaluator: evaluated + ignored by tag + invalid. */
  resourcesReceived: number;
  /** Valid resources that were not ignored and had the rules applied. */
  resourcesEvaluated: number;
  resourcesIgnoredByTag: number;
  /** Malformed inputs that were skipped (never crash the run). */
  invalidResources: InvalidResource[];
  findings: Finding[];
  insufficientData: SkippedResource[];
  /** Sum of monthly estimates for findings whose cost could be estimated. */
  totalMonthlyUsd: number;
  /** Findings whose cost could not be estimated (not counted in the total). */
  unestimatedFindings: number;
}
