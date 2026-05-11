import { createHash } from "node:crypto";

export interface TextPatch {
  path: string;
  beforeHash: string;
  afterHash: string;
  before: string;
  after: string;
}

export function hashText(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function createTextPatch(path: string, before: string, after: string): TextPatch {
  return {
    path,
    before,
    after,
    beforeHash: hashText(before),
    afterHash: hashText(after)
  };
}

export function applyTextPatch(current: string, patch: TextPatch): string {
  const currentHash = hashText(current);
  if (currentHash !== patch.beforeHash) {
    throw new Error(`Patch conflict for ${patch.path}: file changed after proposal.`);
  }

  return patch.after;
}
