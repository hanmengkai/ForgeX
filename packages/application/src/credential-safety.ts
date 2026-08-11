const credentialTokenPatterns = [
  /-----BEGIN (?:RSA |EC |OPENSSH |PGP )?PRIVATE KEY-----/iu,
  /\bAKIA[0-9A-Z]{16}\b/u,
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/u,
  /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}\b/u,
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/u,
  /\bAuthorization\s*:\s*Bearer\s+[A-Za-z0-9._~-]{16,}\b/iu,
];
const credentialAssignmentPattern =
  /["']?(?:password|passwd|pwd|client[\s_-]?secret|api[\s_-]?key|access[\s_-]?token|auth[\s_-]?token|secret[\s_-]?key|token|密码|口令|令牌|私钥|密钥)["']?\s*[:=：]\s*(?:"([^"\r\n]{8,})"|'([^'\r\n]{8,})'|(<[^>\r\n]{3,}>|\[[^\]\r\n]{3,}\]|\$\{[A-Za-z0-9_]{3,}\}|[^\s"'<>]{8,}))/giu;
const safeCredentialPlaceholderPattern =
  /^(?:redacted(?:[-_]secret)?|placeholder|example|change[-_]?me|your[-_]?(?:token|secret|key|password|api[-_]?key)|token|secret|password|api[-_]?key|示例|占位符|已脱敏)$/iu;

const isCredentialPlaceholder = (input: string): boolean => {
  const value = input.normalize("NFKC").trim();
  const unwrapped =
    (value.startsWith("[") && value.endsWith("]")) ||
    (value.startsWith("<") && value.endsWith(">"))
      ? value.slice(1, -1)
      : value.startsWith("${") && value.endsWith("}")
        ? value.slice(2, -1)
        : value;
  return safeCredentialPlaceholderPattern.test(unwrapped);
};

export const containsLikelyPlaintextCredential = (input: string): boolean => {
  const normalized = input.normalize("NFKC");
  if (credentialTokenPatterns.some((pattern) => pattern.test(normalized))) {
    return true;
  }
  return [...normalized.matchAll(credentialAssignmentPattern)].some((match) => {
    const value = match[1] ?? match[2] ?? match[3] ?? "";
    return !isCredentialPlaceholder(value);
  });
};
