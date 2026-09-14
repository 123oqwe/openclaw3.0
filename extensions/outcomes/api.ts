// Outcomes API module exposes the plugin public contract.
import { parseOutcomeRecord } from "./src/domain/schema.js";

/**
 * Validates an opaque restored archive value for the candidate compatibility
 * gate without exposing the plugin's persisted record type or value.
 */
export function assertCandidateOutcomeArchiveRecord(input: unknown): void {
  parseOutcomeRecord(input);
}

export {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginDefinition,
} from "openclaw/plugin-sdk/plugin-entry";
