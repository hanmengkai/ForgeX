import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertDefaultWindowsPrivatePath,
  assertDefaultWindowsTrustedPath,
} from "../src/windows-path-security.js";
import { assertTrustedExecutable } from "../src/trusted-executable.js";

const execFileAsync = promisify(execFile);
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots
      .splice(0)
      .map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("Windows Runner path security", () => {
  it.runIf(process.platform === "win32")(
    "接受由 Windows 系统信任链保护的标准程序及全部祖先路径",
    async () => {
      const powershellPath = path.join(
        process.env.SystemRoot!,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      await expect(
        assertTrustedExecutable({
          commandPath: powershellPath,
          expectedSha256: createHash("sha256")
            .update(await readFile(powershellPath))
            .digest("hex"),
          description: "Windows 系统程序",
        }),
      ).resolves.toBeUndefined();
    },
    15_000,
  );

  it.runIf(process.platform === "win32")(
    "拒绝明确授予其他 Windows 身份修改权限的路径",
    async () => {
      const root = path.join(
        os.tmpdir(),
        `forgex-runner-windows-acl-${randomUUID()}`,
      );
      temporaryRoots.push(root);
      await mkdir(root);
      const systemRoot = process.env.SystemRoot!;
      const powershellPath = path.join(
        systemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
      const script = String.raw`
$acl = Get-Acl -LiteralPath $env:FORGEX_ACL_TEST_TARGET
$acl.SetAccessRuleProtection($true, $false)
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$inheritance = [System.Security.AccessControl.InheritanceFlags]::ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit
$propagation = [System.Security.AccessControl.PropagationFlags]::None
$allow = [System.Security.AccessControl.AccessControlType]::Allow
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($current, 'FullControl', $inheritance, $propagation, $allow))
$everyone = [System.Security.Principal.SecurityIdentifier]::new('S-1-1-0')
$acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new($everyone, 'Modify', $inheritance, $propagation, $allow))
Set-Acl -LiteralPath $env:FORGEX_ACL_TEST_TARGET -AclObject $acl
`;
      await execFileAsync(
        powershellPath,
        ["-NoProfile", "-NonInteractive", "-Command", script],
        {
          env: { SystemRoot: systemRoot, FORGEX_ACL_TEST_TARGET: root },
          windowsHide: true,
        },
      );

      await expect(assertDefaultWindowsPrivatePath(root)).rejects.toThrow(
        "私有路径",
      );
      await expect(assertDefaultWindowsTrustedPath(root)).rejects.toThrow(
        "可信路径",
      );
    },
    15_000,
  );
});
