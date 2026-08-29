import lockDocument from "./kernel-headful.lock.json" with { type: "json" };
import { validateKernelImageLock } from "./kernel-image-lock.ts";

export const KERNEL_HEADFUL_IMAGE_LOCK = validateKernelImageLock(lockDocument);
