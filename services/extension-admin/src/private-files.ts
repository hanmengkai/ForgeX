import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, open, realpath, unlink } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type PrivatePathCheck = (targetPath: string) => Promise<void>;

type WindowsPathPolicy = "private" | "trusted";

const samePath = (left: string, right: string): boolean =>
  process.platform === "win32"
    ? path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase()
    : path.resolve(left) === path.resolve(right);

const assertWindowsPath = async (
  targetPath: string,
  policy: WindowsPathPolicy,
): Promise<void> => {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot || !path.win32.isAbsolute(systemRoot)) {
    throw new Error("扩展管理器无法验证 Windows 私有路径权限");
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
$target = [System.IO.Path]::GetFullPath($env:FORGEX_EXTENSION_PATH)
$policy = $env:FORGEX_EXTENSION_PATH_POLICY
$acl = Get-Acl -LiteralPath $target
$current = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$system = 'S-1-5-18'
$administrators = 'S-1-5-32-544'
$allowed = @($current, $system, $administrators)
$trustedInstaller = 'S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464'
$policyAllowed = if ($policy -eq 'trusted') { @($current, $system, $administrators, $trustedInstaller) } else { $allowed }
$owner = ([System.Security.Principal.NTAccount]$acl.Owner).Translate([System.Security.Principal.SecurityIdentifier]).Value
if ($policy -eq 'private') {
  if ($owner -ne $current) { exit 3 }
} elseif ($policyAllowed -notcontains $owner) {
  exit 3
}
$isDirectory = Test-Path -LiteralPath $target -PathType Container
$writeMask = [System.Security.AccessControl.FileSystemRights]::WriteData -bor
  [System.Security.AccessControl.FileSystemRights]::CreateFiles -bor
  [System.Security.AccessControl.FileSystemRights]::AppendData -bor
  [System.Security.AccessControl.FileSystemRights]::CreateDirectories -bor
  [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
  [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
$trustedMask = [System.Security.AccessControl.FileSystemRights]::Delete -bor
  [System.Security.AccessControl.FileSystemRights]::ChangePermissions -bor
  [System.Security.AccessControl.FileSystemRights]::TakeOwnership
if (-not $isDirectory) {
  $trustedMask = $trustedMask -bor
    [System.Security.AccessControl.FileSystemRights]::WriteData -bor
    [System.Security.AccessControl.FileSystemRights]::AppendData
} else {
  $trustedMask = $trustedMask -bor
    [System.Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles
}
$privateMask = $writeMask -bor
  [System.Security.AccessControl.FileSystemRights]::ReadData -bor
  [System.Security.AccessControl.FileSystemRights]::ListDirectory -bor
  [System.Security.AccessControl.FileSystemRights]::ReadAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::ReadExtendedAttributes -bor
  [System.Security.AccessControl.FileSystemRights]::ReadPermissions
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -ne [System.Security.AccessControl.AccessControlType]::Allow) { continue }
  if (($rule.PropagationFlags -band [System.Security.AccessControl.PropagationFlags]::InheritOnly) -ne 0) { continue }
  if ($policyAllowed -contains $rule.IdentityReference.Value) { continue }
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
          FORGEX_EXTENSION_PATH: targetPath,
          FORGEX_EXTENSION_PATH_POLICY: policy,
        },
        timeout: 10_000,
        windowsHide: true,
      },
    );
  } catch {
    throw new Error(
      policy === "private"
        ? "扩展管理私有路径必须由当前 Windows 用户持有，且不能授权其他本机身份访问"
        : "扩展管理路径祖先不能由其他本机身份替换",
    );
  }
};

export const defaultAssertPrivatePath: PrivatePathCheck = async (
  targetPath,
) => {
  if (process.platform === "win32") {
    await assertWindowsPath(targetPath, "private");
    return;
  }
  const metadata = await lstat(targetPath);
  const currentUser = process.getuid?.();
  if (
    metadata.isSymbolicLink() ||
    (metadata.mode & 0o077) !== 0 ||
    (currentUser !== undefined && metadata.uid !== currentUser)
  ) {
    throw new Error("扩展管理私有路径必须只允许当前控制器身份访问");
  }
};

const ancestorDirectories = (targetPath: string): string[] => {
  const result: string[] = [];
  let current = path.dirname(path.resolve(targetPath));
  while (true) {
    result.push(current);
    const parent = path.dirname(current);
    if (parent === current) return result;
    current = parent;
  }
};

const assertTrustedAncestors = async (targetPath: string): Promise<void> => {
  const currentUser = process.getuid?.();
  for (const directory of ancestorDirectories(targetPath)) {
    const [metadata, resolved] = await Promise.all([
      lstat(directory),
      realpath(directory),
    ]);
    if (
      !metadata.isDirectory() ||
      metadata.isSymbolicLink() ||
      !samePath(resolved, directory)
    ) {
      throw new Error("扩展管理路径祖先不能发生跳转");
    }
    if (process.platform === "win32") {
      await assertWindowsPath(directory, "trusted");
    } else if (
      ((metadata.mode & 0o022) !== 0 && (metadata.mode & 0o1000) === 0) ||
      (currentUser !== undefined &&
        metadata.uid !== 0 &&
        metadata.uid !== currentUser)
    ) {
      throw new Error("扩展管理路径祖先不能由其他本机身份替换");
    }
  }
};

export const assertPrivateDirectory = async (
  directoryInput: string,
  check: PrivatePathCheck,
): Promise<string> => {
  const directory = path.resolve(directoryInput);
  const [metadata, resolvedRealPath] = await Promise.all([
    lstat(directory),
    realpath(directory),
  ]);
  if (
    !metadata.isDirectory() ||
    metadata.isSymbolicLink() ||
    !samePath(resolvedRealPath, directory)
  ) {
    throw new Error("扩展管理目录必须是不跳转的普通目录");
  }
  if (check === defaultAssertPrivatePath) {
    await assertTrustedAncestors(directory);
  }
  await check(directory);
  return directory;
};

export const createPrivateFile = async (
  filePath: string,
  contents: string,
  check: PrivatePathCheck,
): Promise<void> => {
  let handle;
  let created = false;
  try {
    await assertPrivateDirectory(path.dirname(filePath), check);
    handle = await open(filePath, "wx", 0o600);
    created = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(filePath, 0o600);
    await check(filePath);
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (created) await unlink(filePath).catch(() => undefined);
    throw error;
  }
};

export const readPrivateText = async (
  filePathInput: string,
  maxBytes: number,
  check: PrivatePathCheck,
): Promise<string> => {
  const filePath = path.resolve(filePathInput);
  await assertPrivateDirectory(path.dirname(filePath), check);
  const before = await lstat(filePath);
  if (
    !before.isFile() ||
    before.isSymbolicLink() ||
    before.size < 1 ||
    before.size > maxBytes
  ) {
    throw new Error("扩展管理私有文件大小或类型不正确");
  }
  await check(filePath);
  const handle = await open(
    filePath,
    process.platform === "win32"
      ? constants.O_RDONLY
      : constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const metadata = await handle.stat();
    if (metadata.dev !== before.dev || metadata.ino !== before.ino) {
      throw new Error("扩展管理私有文件在读取期间发生替换");
    }
    const contents = await handle.readFile({ encoding: "utf8" });
    const after = await lstat(filePath);
    if (
      after.dev !== metadata.dev ||
      after.ino !== metadata.ino ||
      after.isSymbolicLink()
    ) {
      throw new Error("扩展管理私有文件在读取期间发生替换");
    }
    return contents;
  } finally {
    await handle.close();
  }
};

export const parseJson = (contents: string, label: string): unknown => {
  try {
    return JSON.parse(contents) as unknown;
  } catch {
    throw new Error(`${label}不是有效 JSON`);
  }
};
