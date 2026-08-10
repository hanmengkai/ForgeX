import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const assertWindowsPath = async (
  target: string,
  policy: "private" | "trusted",
): Promise<void> => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("设备无法验证 Windows 路径权限");
  }
  const powershellPath = path.win32.join(
    systemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$target = [System.IO.Path]::GetFullPath($env:FORGEX_DEVICE_ACL_TARGET)
$policy = $env:FORGEX_DEVICE_ACL_POLICY
$acl = Get-Acl -LiteralPath $target
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$allowed = @($current, 'S-1-5-18', 'S-1-5-32-544')
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
if ($policy -eq 'private') {
  if ($owner -ne $current) { exit 3 }
} elseif ($allowed -notcontains $owner) {
  exit 3
}
$privateMask = [System.Security.AccessControl.FileSystemRights]::ReadData -bor
  [System.Security.AccessControl.FileSystemRights]::ReadAndExecute -bor
  [System.Security.AccessControl.FileSystemRights]::WriteData -bor
  [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
$trustedMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
  [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
  [System.Security.AccessControl.FileSystemRights]::AppendData -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
  if ($allowed -contains $rule.IdentityReference.Value) { continue }
  $mask = if ($policy -eq 'private') { $privateMask } else { $trustedMask }
  if (($rule.FileSystemRights -band $mask) -ne 0) { exit 4 }
}
exit 0
`;
  try {
    await execFileAsync(
      powershellPath,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-Command",
        script,
      ],
      {
        env: {
          SystemRoot: systemRoot,
          WINDIR: systemRoot,
          FORGEX_DEVICE_ACL_TARGET: target,
          FORGEX_DEVICE_ACL_POLICY: policy,
        },
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error(
      policy === "private"
        ? "设备私有路径必须由当前 Windows 用户持有，且仅允许当前用户、SYSTEM 和管理员访问"
        : "设备可信路径必须由当前用户、SYSTEM 或管理员持有，且不能由其他 Windows 身份改写",
    );
  }
};

export const assertPrivateWindowsPath = async (target: string): Promise<void> =>
  assertWindowsPath(target, "private");

export const assertTrustedWindowsPath = async (target: string): Promise<void> =>
  assertWindowsPath(target, "trusted");
