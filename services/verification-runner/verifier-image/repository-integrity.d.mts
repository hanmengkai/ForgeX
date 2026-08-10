export interface RepositoryIntegrityResult {
  packageName: string;
  sourceFiles: number;
  inspectedFiles: number;
  inspectedBytes: number;
}

export function verifyRepositoryIntegrity(
  rootInput: string,
): Promise<RepositoryIntegrityResult>;
