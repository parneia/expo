import { readChangesets } from '@changesets/read';
import path from 'node:path';

import * as Directories from '../Directories';
import { spawnAsync } from '../Utils';

const PRECOMPILED_QUERY =
  '{ packages(filter: { has: { field: TASK_NAME, value: "precompile-ios" } }) { items { name } } }';

export async function getRequiredPackagesAsync(): Promise<string[]> {
  const turboBin = path.join(Directories.getNodeModulesDir(), '.bin', 'turbo');
  const { stdout } = await spawnAsync(turboBin, ['query', PRECOMPILED_QUERY], {
    cwd: Directories.getExpoRepositoryRootDir(),
  });
  const items: { name: string }[] = JSON.parse(stdout.slice(stdout.indexOf('{'))).data.packages
    .items;
  return items
    .map((item) => item.name)
    .filter((name) => name !== 'expo-modules-core' && name !== 'expo-modules-jsi')
    .sort();
}

export async function findMissingBumps(
  changesetsDir: string,
  required: string[]
): Promise<string[]> {
  const changesets = await readChangesets(path.dirname(changesetsDir));
  const bumped = new Set(
    changesets.flatMap((changeset) =>
      changeset.releases.filter((release) => release.type !== 'none').map((release) => release.name)
    )
  );
  return required.filter((name) => !bumped.has(name));
}
