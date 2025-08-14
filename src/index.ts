export * from './fallback-core.module';
export * from './fallback-core.service';
export { FALLBACK_CORE_OPTIONS, FallbackCoreModuleAsyncOptions } from './fallback-core.module';
// v2 exports
export * from './utils/types';
export * from './utils/legacy-adapter';
export * from './utils/backoff';
// Legacy type export under alias to avoid name collision with v2 FallbackCoreOptions
export { FallbackCoreOptions as LegacyFallbackCoreOptions } from './interfaces/fallback-core.options';
