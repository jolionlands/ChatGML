// src/index.ts — public barrel (the integration surface).
//
// M1 scope: re-export the shared types, config, and llm client. Tools/agent/memory providers are
// added as their milestones land.
export type * from './types.js';
export * from './tool-error.js';
export * from './config.js';
export * from './llm.js';
