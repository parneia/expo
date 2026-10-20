import { Command } from '@expo/commander';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { EXPO_DIR } from '../Constants';
import logger from '../Logger';
import {
  AbiModule,
  CORE_MODULE,
  JSI_MODULE,
  readBaseVersionAsync,
  resolveBaselineAbiAsync,
  xcframeworkAbiPath,
} from '../swift-abi/Baseline';
import { findMissingBumps, getRequiredPackagesAsync } from '../swift-abi/ChangesetCoverage';
import {
  DigesterFinding,
  isBreakingFinding,
  parseDigesterReport,
  runDigesterAsync,
} from '../swift-abi/Digester';
import { formatAbiFailure, formatAbiFindings } from '../swift-abi/Report';
import {
  demangleAsync,
  findMissingSymbols,
  Flavor,
  parseImports,
  readExportsAsync,
  readImportsAsync,
  resolveModuleBinariesAsync,
  simulatorBinaryPath,
} from '../swift-abi/Symbols';

type ActionOptions = {
  baseRef: string;
};

function currentXcframework(module: AbiModule, flavor: Flavor): string {
  return path.join(
    EXPO_DIR,
    'packages',
    module.packageName,
    '.expo-prebuild/output',
    flavor,
    'xcframeworks',
    `${module.productName}.xcframework`
  );
}

function requireBuildOutput(file: string, module: AbiModule, description: string) {
  if (!fs.existsSync(file)) {
    throw new Error(
      `The Swift ABI check could not find the ${module.productName} ${description} from this branch: ${file}\n` +
        `Run \`bin/expo-turbo run precompile-ios --filter=${module.packageName}\` first.`
    );
  }
}

const FLAVORS: Flavor[] = ['debug', 'release'];

type ExportsByModule = Map<AbiModule, Set<string>>;
type SymbolFinding = [label: string, findings: DigesterFinding[]];

async function readCurrentExportsAsync(flavor: Flavor): Promise<ExportsByModule> {
  const exports: ExportsByModule = new Map();
  for (const module of [CORE_MODULE, JSI_MODULE]) {
    const binary = simulatorBinaryPath(currentXcframework(module, flavor), module.productName);
    requireBuildOutput(binary, module, `${flavor} binary`);
    exports.set(module, await readExportsAsync(binary));
  }
  return exports;
}

async function checkBinaryAsync(
  label: string,
  binary: string,
  exports: ExportsByModule
): Promise<SymbolFinding[]> {
  const imports = await readImportsAsync(binary);
  const findings: SymbolFinding[] = [];
  for (const [module, moduleExports] of exports) {
    const missing = findMissingSymbols(parseImports(imports, module.productName), moduleExports);
    if (missing.length > 0) {
      findings.push([
        `${label} imports ${module.productName} symbols that this branch no longer exports`,
        (await demangleAsync(missing)).map((message) => ({ section: 'Symbols', message })),
      ]);
    }
  }
  return findings;
}

async function checkPackageAsync(
  packageName: string,
  baseRef: string,
  workDir: string,
  exportsByFlavor: Map<Flavor, ExportsByModule>
): Promise<SymbolFinding[]> {
  const version = await readBaseVersionAsync(baseRef, packageName);
  const findings: SymbolFinding[] = [];
  for (const flavor of FLAVORS) {
    const binaries = await resolveModuleBinariesAsync(packageName, version, flavor, workDir);
    for (const { product, binary } of binaries) {
      const label = `${product}@${version} (${flavor})`;
      findings.push(...(await checkBinaryAsync(label, binary, exportsByFlavor.get(flavor)!)));
    }
  }
  return findings;
}

async function checkSymbolsAsync(baseRef: string, workDir: string): Promise<SymbolFinding[]> {
  const exportsByFlavor = new Map<Flavor, ExportsByModule>();
  for (const flavor of FLAVORS) {
    exportsByFlavor.set(flavor, await readCurrentExportsAsync(flavor));
  }
  const packages = await getRequiredPackagesAsync();
  const results = await Promise.all(
    packages.map((packageName) => checkPackageAsync(packageName, baseRef, workDir, exportsByFlavor))
  );
  return results.flat();
}

async function checkModuleAsync(
  module: AbiModule,
  baseRef: string,
  workDir: string
): Promise<DigesterFinding[]> {
  const version = await readBaseVersionAsync(baseRef, module.packageName);
  const baseline = await resolveBaselineAbiAsync(module, version, workDir);
  if (!baseline) {
    logger.info(
      `Skipping ${module.productName}: ${module.packageName}@${version} has no published ABI file to compare with.`
    );
    return [];
  }
  const current = xcframeworkAbiPath(currentXcframework(module, 'release'), module.productName);
  requireBuildOutput(current, module, 'ABI file');
  const findings = parseDigesterReport(await runDigesterAsync(baseline, current));
  logger.info(
    `${module.productName}: compared with ${module.packageName}@${version}, ${findings.length} finding(s).`
  );
  return findings.filter(isBreakingFinding);
}

async function action(options: ActionOptions) {
  const workDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'swift-abi-check-'));
  const findings = new Map<string, DigesterFinding[]>();
  for (const module of [CORE_MODULE, JSI_MODULE]) {
    const moduleFindings = await checkModuleAsync(module, options.baseRef, workDir);
    if (moduleFindings.length > 0) {
      findings.set(`${module.productName} ABI changes`, moduleFindings);
    }
  }
  for (const [label, symbolFindings] of await checkSymbolsAsync(options.baseRef, workDir)) {
    findings.set(label, symbolFindings);
  }
  if (findings.size === 0) {
    logger.success('No Swift ABI breaks found.');
    return;
  }

  const missing = await findMissingBumps(
    path.join(EXPO_DIR, '.changeset'),
    await getRequiredPackagesAsync()
  );
  if (missing.length === 0) {
    logger.info(formatAbiFindings(findings));
    logger.success('A changeset republishes every precompiled package, so the check passes.');
    return;
  }
  logger.error(formatAbiFailure(findings, missing));
  process.exitCode = 1;
}

export default (program: Command) => {
  program
    .command('check-swift-abi')
    .description(
      'Compares the Swift ABI of ExpoModulesCore and ExpoModulesJSI built from this branch with the published versions.'
    )
    .option('--base-ref <ref>', 'Git ref whose package versions are the baseline.', 'origin/main')
    .asyncAction(action);
};
