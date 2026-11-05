import { liveScenarios } from "./live/scenarios";
import { offlineScenarios } from "./offline/scenarios";
import type { Scenario } from "./support/scenario";

export * from "./support/scenario";
export { liveScenarios, offlineScenarios };

// The folder is the contract: a scenario that needs the real model lives in
// `live/`, and every other scenario lives in `offline/`. `run.ts` selects the
// lane before it builds a provider, so the default path never reaches the API.
function assertUnique(lane: string, scenarios: Scenario[]): Set<string> {
  const ids = new Set<string>();
  for (const scenario of scenarios) {
    if (ids.has(scenario.id)) {
      throw new Error(`scenario id ${JSON.stringify(scenario.id)} is repeated in the ${lane} lane`);
    }
    ids.add(scenario.id);
  }
  return ids;
}

const offlineIds = assertUnique("offline", offlineScenarios);
const liveIds = assertUnique("live", liveScenarios);
for (const id of liveIds) {
  if (offlineIds.has(id)) {
    throw new Error(`scenario id ${JSON.stringify(id)} is defined in both lanes`);
  }
}

export const scenarios: Scenario[] = [...offlineScenarios, ...liveScenarios];
