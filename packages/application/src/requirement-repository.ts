import type { RequirementSpec } from "@forgex/contracts";
import type {
  RequirementAllowedAction,
  RequirementPeopleView,
  RequirementWorkflow,
} from "@forgex/domain";

export type RequirementAuditAction =
  | "requirement.created"
  | "requirement.confirmation_submitted"
  | "requirement.confirmed"
  | "delivery.requested"
  | "delivery.dispatched";

export interface DeliveryDispatchRecord {
  dispatchKey: string;
  tenantKey: string;
  projectKey: string;
  requirementKey: string;
  requirementRevision: number;
  title: string;
  requiredCapabilities: string[];
  requestedAt: string;
  dispatchedAt: string | null;
}

export interface RequirementAuditEvent {
  eventKey: string;
  tenantKey: string;
  projectKey: string;
  requirementKey: string;
  action: RequirementAuditAction;
  actorKey: string;
  actorName: string;
  recordedAt: string;
}

export interface RequirementRecord {
  tenantKey: string;
  projectKey: string;
  requirementKey: string;
  createdAt: string;
  spec: RequirementSpec;
  workflow: RequirementWorkflow;
}

export interface RequirementListOptions {
  afterPosition?: number;
  limit: number;
}

export interface RequirementListItem {
  requirementKey: string;
  view: RequirementPeopleView;
  allowedActions: RequirementAllowedAction[];
}

export interface RequirementListPage {
  items: RequirementListItem[];
  nextPosition: number | null;
}

export interface RequirementTransaction {
  find(requirementKey: string): Promise<RequirementRecord | null>;
  save(record: RequirementRecord): void;
  appendAudit(event: RequirementAuditEvent): void;
  appendDeliveryDispatch(record: DeliveryDispatchRecord): void;
  markDeliveryDispatched(
    dispatchKey: string,
    dispatchedAt: string,
  ): Promise<boolean>;
}

export interface RequirementRepository {
  transaction<T>(
    tenantKey: string,
    projectKey: string,
    operation: (transaction: RequirementTransaction) => Promise<T> | T,
  ): Promise<T>;
  listForPeople(
    tenantKey: string,
    projectKey: string,
    options: RequirementListOptions,
  ): Promise<RequirementListPage>;
  listAuditEvents(
    tenantKey: string,
    projectKey: string,
  ): Promise<RequirementAuditEvent[]>;
  listPendingDeliveryDispatches(
    tenantKey: string,
    projectKey: string | null,
    limit: number,
  ): Promise<DeliveryDispatchRecord[]>;
}
