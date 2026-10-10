export type PlatformRole =
  | "product_owner"
  | "requirement_analyst"
  | "developer"
  | "administrator"
  | "requester"
  | "tester"
  | "test_ops"
  | "production_ops";

export interface AuthenticatedPrincipal {
  actorKey: string;
  actorName: string;
  username?: string | undefined;
  tenantKey: string;
  roles: PlatformRole[];
}

export interface SessionAuthenticator {
  authenticate(
    authorization: string | undefined,
  ): Promise<AuthenticatedPrincipal | null>;
}
