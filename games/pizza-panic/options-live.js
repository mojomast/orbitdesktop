// Shared live accessibility values. options.js owns the store and the API; this module
// holds one instance so modules that are not wired through game.js (cinematics, fx,
// the HUD) can read the current settings without an import cycle back through game.js.
import { createOptions } from './options.js';
export const OPTIONS = createOptions();
export default OPTIONS;
