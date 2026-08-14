import path from "node:path";

import { z } from "zod";

const absolutePath = z
  .string()
  .trim()
  .min(1)
  .max(1_000)
  .refine((value) => path.isAbsolute(value), "Codex 登录文件必须使用绝对路径");

export const CodexAuthenticationSchema = z
  .discriminatedUnion("store", [
    z.object({ store: z.literal("keyring") }).strict(),
    z
      .object({
        store: z.literal("file"),
        authFilePath: absolutePath,
      })
      .strict(),
  ])
  .default({ store: "keyring" });

export type CodexAuthentication = z.infer<typeof CodexAuthenticationSchema>;

export const codexProtectedPaths = (
  authentication: CodexAuthentication,
  controllerPaths: string[],
  repositoryPaths: string[],
): string[] => [
  ...controllerPaths,
  ...(authentication.store === "keyring" ? repositoryPaths : []),
];
