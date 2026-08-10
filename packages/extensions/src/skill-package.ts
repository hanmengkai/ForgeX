import { z } from "zod";

const MAX_SKILL_PACKAGE_BYTES = 20 * 1024 * 1024;

const windowsReservedSegment =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;

const isCrossPlatformSafeResourcePath = (value: string): boolean => {
  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.endsWith(".") &&
      !segment.endsWith(" ") &&
      !windowsReservedSegment.test(segment),
  );
};

const resourcePath = z
  .string()
  .min(3)
  .max(240)
  .regex(/^(?:references|scripts|assets)\/[A-Za-z0-9][A-Za-z0-9._/-]*$/)
  .refine(
    (value) => isCrossPlatformSafeResourcePath(value),
    "Skill 资源路径必须是安全的包内相对路径",
  );

const canonicalBase64 = z
  .string()
  .max(2_800_000)
  .superRefine((value, context) => {
    try {
      if (Buffer.from(value, "base64").toString("base64") !== value) {
        context.addIssue({
          code: "custom",
          message: "资源内容不是规范 Base64",
        });
      }
    } catch {
      context.addIssue({ code: "custom", message: "资源内容不是规范 Base64" });
    }
  });

const SkillPackageResourceSchema = z
  .object({
    path: resourcePath,
    mediaType: z.enum([
      "text/markdown",
      "text/plain",
      "application/json",
      "application/javascript",
      "text/x-python",
      "text/x-shellscript",
      "application/octet-stream",
    ]),
    encoding: z.enum(["utf8", "base64"]),
    content: z.string().max(2_800_000),
  })
  .strict()
  .superRefine((resource, context) => {
    if (resource.encoding === "base64") {
      const parsed = canonicalBase64.safeParse(resource.content);
      if (!parsed.success) {
        context.addIssue({
          code: "custom",
          path: ["content"],
          message: "资源内容不是规范 Base64",
        });
      }
    }
    if (
      resource.encoding === "utf8" &&
      resource.mediaType === "application/octet-stream"
    ) {
      context.addIssue({
        code: "custom",
        path: ["encoding"],
        message: "二进制资源必须使用 Base64",
      });
    }
  });

export const SkillPackageContentSchema = z
  .object({
    schemaVersion: z.literal(1),
    instructions: z.string().trim().min(20).max(200_000),
    resources: z.array(SkillPackageResourceSchema).max(100),
  })
  .strict()
  .superRefine((content, context) => {
    const paths = new Set<string>();
    let totalBytes = Buffer.byteLength(content.instructions, "utf8");
    for (const [index, resource] of content.resources.entries()) {
      const normalizedPath = resource.path.toLowerCase();
      if (paths.has(normalizedPath)) {
        context.addIssue({
          code: "custom",
          path: ["resources", index, "path"],
          message: "Skill 资源路径不能重复",
        });
      }
      paths.add(normalizedPath);
      totalBytes +=
        resource.encoding === "base64"
          ? Buffer.from(resource.content, "base64").byteLength
          : Buffer.byteLength(resource.content, "utf8");
    }
    if (totalBytes > MAX_SKILL_PACKAGE_BYTES) {
      context.addIssue({
        code: "custom",
        path: ["resources"],
        message: "Skill 包解码后的内容不能超过 20 MB",
      });
    }
  });

export type SkillPackageContent = z.infer<typeof SkillPackageContentSchema>;

const canonicalContent = (input: SkillPackageContent): SkillPackageContent => {
  const parsed = SkillPackageContentSchema.parse(input);
  return {
    schemaVersion: 1,
    instructions: parsed.instructions,
    resources: [...parsed.resources]
      .sort((left, right) =>
        left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
      )
      .map((resource) => ({
        path: resource.path,
        mediaType: resource.mediaType,
        encoding: resource.encoding,
        content: resource.content,
      })),
  };
};

export class SkillPackageCodec {
  static encode(input: SkillPackageContent): Uint8Array {
    const bytes = Buffer.from(JSON.stringify(canonicalContent(input)), "utf8");
    if (bytes.byteLength > MAX_SKILL_PACKAGE_BYTES) {
      throw new Error("Skill 包不能超过 20 MB");
    }
    return Uint8Array.from(bytes);
  }

  static decode(input: Uint8Array): SkillPackageContent {
    const bytes = Uint8Array.from(input);
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_SKILL_PACKAGE_BYTES) {
      throw new Error("Skill 包大小无效");
    }
    let value: unknown;
    try {
      const json = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      value = JSON.parse(json) as unknown;
    } catch {
      throw new Error("Skill 包不是有效的 UTF-8 JSON");
    }
    const parsed = SkillPackageContentSchema.safeParse(value);
    if (!parsed.success) throw new Error("Skill 包内容格式无效");
    const canonicalBytes = SkillPackageCodec.encode(parsed.data);
    if (!Buffer.from(canonicalBytes).equals(Buffer.from(bytes))) {
      throw new Error("Skill 包必须使用规范编码");
    }
    return structuredClone(canonicalContent(parsed.data));
  }
}
