import type { Config } from "./types.js";

/**
 * Default configuration. Type-annotated as `Config` so it is guaranteed to be
 * schema-complete at compile time.
 */
export const defaultConfig: Config = {
  models: {
    primaryReviewer: "claude",
    secondaryReviewer: "codex",
    judge: "claude",
  },
  verification: {
    commands: ["npm test", "npm run lint"],
  },
  review: {
    maxFindings: 20,
    includeNiceToHave: false,
  },
};
