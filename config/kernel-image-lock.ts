export const KERNEL_IMAGE_REPOSITORY = "docker.io/onkernel/chromium-headful";

export interface KernelImageLock {
  readonly schemaVersion: 1;
  readonly repository: string;
  readonly kernelSourceCommit: string;
  readonly upstreamTag: string;
  readonly ociIndexDigest: string;
  readonly platform: {
    readonly os: "linux";
    readonly architecture: "amd64";
    readonly digest: string;
  };
  readonly runtimeReference: string;
  readonly verifiedAt: string;
  readonly verificationTool: string;
}

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const commitPattern = /^[0-9a-f]{40}$/;

export function validateKernelImageLock(value: unknown): KernelImageLock {
  if (!isObject(value) || value.schemaVersion !== 1) invalid("schemaVersion must be 1");
  const repository = requiredString(value, "repository");
  const kernelSourceCommit = requiredString(value, "kernelSourceCommit");
  const upstreamTag = requiredString(value, "upstreamTag");
  const ociIndexDigest = requiredString(value, "ociIndexDigest");
  const runtimeReference = requiredString(value, "runtimeReference");
  const verifiedAt = requiredString(value, "verifiedAt");
  const verificationTool = requiredString(value, "verificationTool");
  const platform = value.platform;

  if (repository !== KERNEL_IMAGE_REPOSITORY) invalid("repository is not canonical");
  if (!commitPattern.test(kernelSourceCommit)) invalid("kernelSourceCommit is not a full commit");
  if (upstreamTag !== kernelSourceCommit.slice(0, 7)) {
    invalid("upstreamTag does not match kernelSourceCommit");
  }
  if (!digestPattern.test(ociIndexDigest)) invalid("ociIndexDigest is not a sha256 digest");
  if (!isObject(platform)) invalid("platform must be an object");
  if (platform.os !== "linux" || platform.architecture !== "amd64") {
    invalid("platform must be linux/amd64");
  }
  const platformDigest = requiredString(platform, "digest");
  if (!digestPattern.test(platformDigest)) invalid("platform digest is not a sha256 digest");
  if (runtimeReference !== `${repository}@${platformDigest}`) {
    invalid("runtimeReference does not match the platform digest");
  }
  if (new Date(verifiedAt).toISOString() !== verifiedAt) {
    invalid("verifiedAt must be an ISO-8601 timestamp");
  }

  return {
    schemaVersion: 1,
    repository,
    kernelSourceCommit,
    upstreamTag,
    ociIndexDigest,
    platform: { os: "linux", architecture: "amd64", digest: platformDigest },
    runtimeReference,
    verifiedAt,
    verificationTool,
  };
}

function requiredString(object: Record<string, unknown>, key: string): string {
  const value = object[key];
  if (typeof value !== "string" || value.trim() === "") invalid(`${key} must be a string`);
  return value;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): never {
  throw new Error(`invalid Kernel image lock: ${message}`);
}
