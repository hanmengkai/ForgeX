export type PlatformRole =
  "product_owner" | "requirement_analyst" | "developer" | "administrator";

export interface AuthenticatedPrincipal {
  actorKey: string;
  actorName: string;
  tenantKey: string;
  roles: PlatformRole[];
}

export interface SessionAuthenticator {
  authenticate(
    authorization: string | undefined,
  ): Promise<AuthenticatedPrincipal | null>;
}
