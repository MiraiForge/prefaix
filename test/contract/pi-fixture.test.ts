// Runs the AgentPort contract against PiAdapter with fixture replay, the same
// suite the fake backend runs (DESIGN §12.2). Fixtures are built from pi's own
// type definitions; see docs/spikes/S1-pi-rpc-lifecycle.md.

import { runContractSuite } from "./suite.js";
import { piTarget } from "./pi-target.js";

runContractSuite(piTarget());
