import type { AuthenticatedPrincipal, PlatformRole } from "./auth.js";

export type RequirementAuthorizedAction =
  | "create"
  | "revise"
  | "submitForConfirmation"
  | "confirm"
  | "startDelivery"
  | "accept"
  | "viewPreview";

const rolesByAction = {
  create: new Set<PlatformRole>([
    "product_owner",
    "requirement_analyst",
    "administrator",
  ]),
  revise: new Set<PlatformRole>([
    "product_owner",
    "requirement_analyst",
    "administrator",
  ]),
  submitForConfirmation: new Set<PlatformRole>([
    "product_owner",
    "requirement_analyst",
    "administrator",
  ]),
  confirm: new Set<PlatformRole>(["product_owner", "administrator"]),
  startDelivery: new Set<PlatformRole>(["product_owner", "administrator"]),
  accept: new Set<PlatformRole>(["product_owner", "administrator"]),
  viewPreview: new Set<PlatformRole>([
    "product_owner",
    "requirement_analyst",
    "developer",
    "administrator",
  ]),
} satisfies Record<RequirementAuthorizedAction, ReadonlySet<PlatformRole>>;

export const canPerformRequirementAction = (
  principal: AuthenticatedPrincipal,
  action: RequirementAuthorizedAction,
): boolean => principal.roles.some((role) => rolesByAction[action].has(role));
