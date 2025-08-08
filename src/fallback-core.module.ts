import { DynamicModule, Module, Provider } from '@nestjs/common';
import { FallbackCoreService } from './fallback-core.service';
import { FallbackCoreOptions } from './interfaces/fallback-core.options';

export const FALLBACK_CORE_OPTIONS = Symbol('FALLBACK_CORE_OPTIONS');

export interface FallbackCoreModuleAsyncOptions<TInput, TResult> {
  useFactory: (...args: any[]) => Promise<FallbackCoreOptions<TInput, TResult>> | FallbackCoreOptions<TInput, TResult>;
  inject?: any[];
}

@Module({})
export class FallbackCoreModule {
  static forRoot<TInput, TResult>(options: FallbackCoreOptions<TInput, TResult>): DynamicModule {
    return {
      module: FallbackCoreModule,
      providers: [
        { provide: FALLBACK_CORE_OPTIONS, useValue: options },
        {
          provide: FallbackCoreService,
          useFactory: (opts: FallbackCoreOptions<TInput, TResult>) => new FallbackCoreService<TInput, TResult>(opts),
          inject: [FALLBACK_CORE_OPTIONS],
        },
      ],
      exports: [FallbackCoreService],
    };
  }

  static forRootAsync<TInput, TResult>(options: FallbackCoreModuleAsyncOptions<TInput, TResult>): DynamicModule {
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
          useFactory: (opts: FallbackCoreOptions<TInput, TResult>) => new FallbackCoreService<TInput, TResult>(opts),
          inject: [FALLBACK_CORE_OPTIONS],
        },
      ],
      exports: [FallbackCoreService],
    };
  }
}
