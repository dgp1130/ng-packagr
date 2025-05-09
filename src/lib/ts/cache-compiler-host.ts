import type { CompilerHost, CompilerOptions } from '@angular/compiler-cli';
import { createHash } from 'crypto';
import { formatMessages } from 'esbuild';
import assert from 'node:assert';
import * as path from 'path';
import ts from 'typescript';
import { NgPackageConfig } from '../../ng-package.schema';
import { FileCache } from '../file-system/file-cache';
import { BuildGraph } from '../graph/build-graph';
import { Node } from '../graph/node';
import { EntryPointNode, fileUrl } from '../ng-package/nodes';
import { StylesheetProcessor } from '../styles/stylesheet-processor';
import { error, warn } from '../utils/log';
import { ensureUnixPath } from '../utils/path';

export function cacheCompilerHost(
  graph: BuildGraph,
  entryPoint: EntryPointNode,
  compilerOptions: CompilerOptions,
  moduleResolutionCache: ts.ModuleResolutionCache,
  stylesheetProcessor?: StylesheetProcessor,
  inlineStyleLanguage?: NgPackageConfig['inlineStyleLanguage'],
  sourcesFileCache: FileCache = entryPoint.cache.sourcesFileCache,
): CompilerHost {
  const compilerHost = ts.createIncrementalCompilerHost(compilerOptions);

  const getNode = (fileName: string) => {
    const nodeUri = fileUrl(ensureUnixPath(fileName));
    let node = graph.get(nodeUri);

    if (!node) {
      node = new Node(nodeUri);
      graph.put(node);
    }

    return node;
  };

  const addDependee = (fileName: string) => {
    const node = getNode(fileName);
    entryPoint.dependsOn(node);
  };

  return {
    ...compilerHost,

    // Set the parsing mode to the same as TS 5.3+ default for tsc. This provides a parse
    // performance improvement by skipping non-type related JSDoc parsing.
    jsDocParsingMode: ts.JSDocParsingMode.ParseForTypeErrors,

    // ts specific
    getModuleResolutionCache: () => moduleResolutionCache,

    fileExists: (fileName: string) => {
      const cache = sourcesFileCache.getOrCreate(fileName);
      if (cache.exists === undefined) {
        cache.exists = compilerHost.fileExists.call(this, fileName);
      }

      return cache.exists;
    },

    getSourceFile: (fileName, languageVersion, onError, shouldCreateNewSourceFile, ...parameters) => {
      addDependee(fileName);
      const cache = sourcesFileCache.getOrCreate(fileName);

      if (shouldCreateNewSourceFile || !cache.sourceFile) {
        cache.sourceFile = compilerHost.getSourceFile.call(
          this,
          fileName,
          languageVersion,
          onError,
          true,
          ...parameters,
        );
      }

      return cache.sourceFile;
    },

    writeFile: (
      fileName: string,
      data: string,
      writeByteOrderMark: boolean,
      onError?: (message: string) => void,
      sourceFiles?: ReadonlyArray<ts.SourceFile>,
    ) => {
      if (fileName.includes('.ngtypecheck.')) {
        return;
      }

      const extension = path.extname(fileName);
      if (!sourceFiles?.length && extension === '.tsbuildinfo') {
        // Save builder info contents to specified location
        compilerHost.writeFile.call(this, fileName, data, writeByteOrderMark, onError, sourceFiles);

        return;
      }

      assert(sourceFiles?.length === 1, 'Invalid TypeScript program emit for ' + fileName);
      const outputCache = entryPoint.cache.outputCache;
      if (outputCache.get(fileName)?.content === data) {
        return;
      }

      outputCache.set(fileName, {
        content: data,
        version: createHash('sha256').update(data).digest('hex'),
      });
    },

    readFile: (fileName: string) => {
      addDependee(fileName);
      const cache = sourcesFileCache.getOrCreate(fileName);
      if (cache.content === undefined) {
        cache.content = compilerHost.readFile.call(this, fileName);
      }

      return cache.content;
    },

    resourceNameToFileName: (resourceName: string, containingFilePath: string) => {
      const resourcePath = path.resolve(path.dirname(containingFilePath), resourceName);
      const containingNode = getNode(containingFilePath);
      const resourceNode = getNode(resourcePath);
      containingNode.dependsOn(resourceNode);

      return resourcePath;
    },

    readResource: async (fileName: string) => {
      addDependee(fileName);

      const cache = sourcesFileCache.getOrCreate(fileName);
      if (cache.content === undefined) {
        if (!compilerHost.fileExists(fileName)) {
          throw new Error(`Cannot read file ${fileName}.`);
        }

        if (/(?:html?|svg)$/.test(path.extname(fileName))) {
          // template
          cache.content = compilerHost.readFile.call(this, fileName);
        } else {
          // stylesheet
          const {
            referencedFiles,
            contents,
            errors: esbuildErrors,
            warnings: esBuildWarnings,
          } = await stylesheetProcessor.bundleFile(fileName);
          const node = getNode(fileName);
          const depNodes = [...referencedFiles].map(getNode).filter(n => n !== node);
          node.dependsOn(depNodes);

          for (const n of node.dependees) {
            if (n.url.endsWith('.ts')) {
              n.dependsOn(depNodes);
            }
          }

          if (esBuildWarnings?.length > 0) {
            (await formatMessages(esBuildWarnings, { kind: 'warning' })).forEach(msg => warn(msg));
          }

          if (esbuildErrors?.length > 0) {
            (await formatMessages(esbuildErrors, { kind: 'error' })).forEach(msg => error(msg));

            throw new Error(`An error has occuried while processing ${fileName}.`);
          }

          return contents;
        }

        cache.exists = true;
      }

      return cache.content;
    },
    transformResource: async (data, context) => {
      const { containingFile, resourceFile, type } = context;

      if (resourceFile || type !== 'style') {
        return null;
      }

      if (inlineStyleLanguage) {
        const {
          contents,
          referencedFiles,
          errors: esbuildErrors,
          warnings: esBuildWarnings,
        } = await stylesheetProcessor.bundleInline(
          data,
          containingFile,
          containingFile.endsWith('.html') ? 'css' : inlineStyleLanguage,
        );

        const node = getNode(containingFile);
        node.dependsOn([...referencedFiles].map(getNode));

        if (esBuildWarnings?.length > 0) {
          (await formatMessages(esBuildWarnings, { kind: 'warning' })).forEach(msg => warn(msg));
        }

        if (esbuildErrors?.length > 0) {
          (await formatMessages(esbuildErrors, { kind: 'error' })).forEach(msg => error(msg));

          throw new Error(`An error has occuried while processing ${containingFile}.`);
        }

        return { content: contents };
      }

      return null;
    },
  };
}

export function augmentProgramWithVersioning(program: ts.Program): void {
  const baseGetSourceFiles = program.getSourceFiles;
  program.getSourceFiles = function (...parameters) {
    const files: readonly (ts.SourceFile & { version?: string })[] = baseGetSourceFiles(...parameters);

    for (const file of files) {
      if (file.version === undefined) {
        file.version = createHash('sha256').update(file.text).digest('hex');
      }
    }

    return files;
  };
}
