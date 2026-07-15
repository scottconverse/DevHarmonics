import type { LocalResourceSnapshot } from "./resources.js";

export interface CapacityDecision {
  requestedConcurrency: number;
  effectiveConcurrency: number;
  localSlots: number;
  productAgentCeiling: null;
  reasons: string[];
}

export class CapacityBroker {
  decide(input: { requestedConcurrency: number; userCeiling: number | null; resources: LocalResourceSnapshot }): CapacityDecision {
    const requested = Math.max(1, Math.floor(input.requestedConcurrency));
    const effective = input.userCeiling === null ? requested : Math.min(requested, input.userCeiling);
    return {
      requestedConcurrency: requested,
      effectiveConcurrency: effective,
      localSlots: input.resources.advisoryLocalSlots,
      productAgentCeiling: null,
      reasons: [
        input.userCeiling === null ? "no product-level agent ceiling" : `user ceiling ${input.userCeiling}`,
        `local runtime advisory capacity ${input.resources.advisoryLocalSlots}`,
        "provider cooldowns are enforced per assignment",
      ],
    };
  }
}
