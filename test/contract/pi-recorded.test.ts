// Native pi 1.0.4 captures: live Kimi lifecycle and controlled loopback retry.
// Source labels/provenance stay in the fixtures; this never starts real pi.
import { runContractSuite } from "./suite.js";
import { piTarget } from "./pi-target.js";

runContractSuite(piTarget({ recorded: true }));
