import type { AuthenticatedPrincipal, PlatformRole } from "./auth.js";

export type RequirementAuthorizedAction =
  "create" | "submitForConfirmation" | "confirm" | "startDelivery";

const rolesByAction = {
  create: new Set<PlatformRole>([
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
} satisfies Record<RequirementAuthorizedAction, ReadonlySet<PlatformRole>>;

export const canPerformRequirementAction = (
  principal: AuthenticatedPrincipal,
  action: RequirementAuthorizedAction,
): boolean => principal.roles.some((role) => rolesByAction[action].has(role));
