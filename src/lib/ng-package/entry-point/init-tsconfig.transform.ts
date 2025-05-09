import type { ParsedConfiguration } from '@angular/compiler-cli';
import { Transform, transformFromPromise } from '../../graph/transform';
import { initializeTsConfig } from '../../ts/tsconfig';
import { EntryPointNode, isEntryPoint } from '../nodes';

export const initTsConfigTransformFactory = (defaultTsConfig: ParsedConfiguration | string | undefined): Transform =>
  transformFromPromise(graph => {
    // Initialize tsconfig for each entry point
    const entryPoints: EntryPointNode[] = graph.filter(isEntryPoint);

    return initializeTsConfig(defaultTsConfig, entryPoints);
  });
