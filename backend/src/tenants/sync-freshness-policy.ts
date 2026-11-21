// Compatibility entry point. Definitions live in the dependency-free existing
// projection module so direct cross-layer consumers need no runtime loader changes.
export {
  LEGACY_SYNC_FRESHNESS_WINDOWS,
  syncFreshnessWindow,
  resourceFreshnessWindow,
} from './service-sync-freshness.js'
