import { DynamicModule, Module, Provider } from '@nestjs/common';
import { FallbackCoreService } from './fallback-core.service';
import { FallbackCoreOptions as V2Options } from './utils/types';
import { FallbackCoreOptions as LegacyOptions } from './interfaces/fallback-core.options';

export const FALLBACK_CORE_OPTIONS = Symbol('FALLBACK_CORE_OPTIONS');

export interface FallbackCoreModuleAsyncOptions<TInput = any, TResult = any, Ops extends Record<string, any> = any> {
  useFactory: (
    ...args: any[]
  ) => Promise<V2Options<Ops> | LegacyOptions<TInput, TResult>> | V2Options<Ops> | LegacyOptions<TInput, TResult>;
  inject?: any[];
}

@Module({})
export class FallbackCoreModule {
  static forRoot<TInput = any, TResult = any, Ops extends Record<string, any> = any>(options: V2Options<Ops> | LegacyOptions<TInput, TResult>): DynamicModule {
    return {
      module: FallbackCoreModule,
      providers: [
        { provide: FALLBACK_CORE_OPTIONS, useValue: options },
        {
          provide: FallbackCoreService,
          useFactory: (opts: V2Options<Ops> | LegacyOptions<TInput, TResult>) => new FallbackCoreService<Ops>(opts as any),
          inject: [FALLBACK_CORE_OPTIONS],
        },
      ],
      exports: [FallbackCoreService],
    };
  }

  static forRootAsync<TInput = any, TResult = any, Ops extends Record<string, any> = any>(options: FallbackCoreModuleAsyncOptions<TInput, TResult, Ops>): DynamicModule {
    const asyncOptionsProvider: Provider = {
      provide: FALLBACK_CORE_OPTIONS,
      useFactory: options.useFactory,
      inject: options.inject ?? [],
    };

    return {
      module: FallbackCoreModule,
      providers: [
        asyncOptionsProvider,
        {
          provide: FallbackCoreService,
          useFactory: (opts: V2Options<Ops> | LegacyOptions<TInput, TResult>) => new FallbackCoreService<Ops>(opts as any),
          inject: [FALLBACK_CORE_OPTIONS],
        },
      ],
      exports: [FallbackCoreService],
    };
  }
}
