import * as chokidar from 'chokidar';
import { platform } from 'os';
import * as path from 'path';
import { Observable, Observer } from 'rxjs';
import { BuildGraph } from '../graph/build-graph';
import { Node, STATE_PENDING } from '../graph/node';
import { fileUrl, fileUrlPath, isEntryPoint } from '../ng-package/nodes';
import * as log from '../utils/log';
import { ensureUnixPath } from '../utils/path';
import { FileCache } from './file-cache';

type AllFileWatchEvents = 'change' | 'unlink' | 'add' | 'unlinkDir' | 'addDir';
export type FileWatchEvent = Exclude<AllFileWatchEvents, 'unlinkDir' | 'addDir'>;

export interface FileChangedEvent {
  filePath: string;
  event: FileWatchEvent;
}

export function createFileWatch(
  basePaths: string | string[],
  ignoredPaths: string[] = [],
  poll?: number,
): {
  watcher: chokidar.FSWatcher;
  onFileChange: Observable<FileChangedEvent>;
} {
  log.debug(`Watching for changes: basePath: ${basePaths}, ignoredPaths: ${ignoredPaths}`);

  const watch = chokidar.watch([], {
    ignoreInitial: true,
    ignored: [
      /\.map$/,
      /.tsbuildinfo$/,
      file => {
        const normalizedPath = ensureUnixPath(file);

        return ignoredPaths.some(f => normalizedPath.startsWith(f));
      },
    ],
    persistent: true,
    usePolling: typeof poll === 'number' ? true : false,
    interval: typeof poll === 'number' ? poll : undefined,
  });

  const isLinux = platform() === 'linux';
  const handleFileChange = (event: AllFileWatchEvents, filePath: string, observer: Observer<FileChangedEvent>) => {
    log.debug(`Watch: Path changed. Event: ${event}, Path: ${filePath}`);

    if (isLinux) {
      // Workaround for Linux where chokidar will not handle future events
      // for files that were unlinked and immediately recreated.
      watch.unwatch(filePath);
      watch.add(filePath);
    }

    if (event === 'unlinkDir' || event === 'addDir') {
      // we don't need to trigger on directory removed or renamed as chokidar will fire the changes for each file
      return;
    }

    observer.next({
      filePath: ensureUnixPath(path.resolve(filePath)),
      event,
    });
  };

  return {
    watcher: watch,
    onFileChange: new Observable(observer => {
      watch.on('all', (event: AllFileWatchEvents, filePath: string) => handleFileChange(event, filePath, observer));

      // eslint-disable-next-line @typescript-eslint/no-misused-promises
      return () => watch.close();
    }),
  };
}

/**
 * Invalidates entry points and cache when specified files change.
 *
 * @returns - Returns `true` if any entry point was invalidated, otherwise `false`.
 */
export function invalidateEntryPointsAndCacheOnFileChange(
  graph: BuildGraph,
  files: string[],
  sourcesFileCache: FileCache,
): boolean {
  let invalidatedEntryPoint = false;
  const allNodesToClean: Map<string, Node> = new Map();

  for (const filePath of files) {
    const changedFileUrl = fileUrl(filePath);
    const nodeToClean = graph.find(node => changedFileUrl === node.url);
    if (!nodeToClean) {
      continue;
    }

    allNodesToClean.set(filePath, nodeToClean);
  }

  // delete node that changes
  const potentialStylesResources = new Set<string>();
  for (const [filePath, nodeToClean] of allNodesToClean) {
    sourcesFileCache.delete(filePath);

    if (filePath.endsWith('.ts')) {
      continue;
    }

    // if a non ts file changes we need to clean up its direct dependees
    // this is mainly done for resources such as html and css
    potentialStylesResources.add(filePath);
    for (const dependees of nodeToClean.dependees) {
      const filePath = fileUrlPath(dependees.url);
      if (!filePath) {
        continue;
      }

      allNodesToClean.set(filePath, dependees);

      if (!filePath.endsWith('.ts')) {
        potentialStylesResources.add(filePath);
      }
    }
  }

  const entryPoints = graph.filter(isEntryPoint);
  for (const entryPoint of entryPoints) {
    let isDirty = false;
    if (potentialStylesResources.size > 0) {
      isDirty = !!entryPoint.cache.stylesheetProcessor?.invalidate(potentialStylesResources)?.length;
    }

    for (const [filePath, dependent] of allNodesToClean) {
      if (!entryPoint.dependents.has(dependent)) {
        continue;
      }

      entryPoint.cache.analysesSourcesFileCache.delete(filePath);
      isDirty = true;
    }

    if (isDirty) {
      entryPoint.state = STATE_PENDING;
      invalidatedEntryPoint = true;
    }
  }

  return invalidatedEntryPoint;
}
