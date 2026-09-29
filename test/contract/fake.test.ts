// Runs the AgentPort contract against the scripted fake. The pi-fixture target
// lands with the pi adapter (M2-4/M2-5) and reuses this same suite.

import { runContractSuite } from "./suite.js";
import { fakeTarget } from "./fake-target.js";

runContractSuite(fakeTarget());
