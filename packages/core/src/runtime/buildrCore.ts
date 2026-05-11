import { DefaultPermissionPolicy, type PermissionPolicy } from "../permissions/policy.js";
import { createDefaultPlan, type BuildrPlan } from "../plans/schema.js";
import { OllamaAdapter } from "../providers/ollama.js";
import type { ModelAdapter } from "../types.js";

export interface BuildrCoreOptions {
  model?: ModelAdapter;
  permissions?: PermissionPolicy;
}

export class BuildrCore {
  readonly model: ModelAdapter;
  readonly permissions: PermissionPolicy;

  constructor(options: BuildrCoreOptions = {}) {
    this.model = options.model ?? new OllamaAdapter();
    this.permissions = options.permissions ?? new DefaultPermissionPolicy();
  }

  createPlan(goal: string): BuildrPlan {
    return createDefaultPlan(goal);
  }
}
