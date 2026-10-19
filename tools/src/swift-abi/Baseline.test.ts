import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { CORE_MODULE, JSI_MODULE, NpmPack, resolveBaselineAbiAsync } from './Baseline';

const SLICE_ABI =
  'ios-arm64_x86_64-simulator/ExpoModulesCore.framework/Modules/ExpoModulesCore.swiftmodule/arm64-apple-ios-simulator.abi.json';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'abi-baseline-'));
}

function tar(args: string[]) {
  const result = spawnSync('tar', args, { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
}

function packFrom(packageRoot: string): NpmPack {
  return async (_spec, destination) => {
    const tarball = path.join(destination, 'package.tgz');
    tar(['-czf', tarball, '-C', path.dirname(packageRoot), path.basename(packageRoot)]);
    return tarball;
  };
}

describe('resolveBaselineAbiAsync', () => {
  it('returns null when the version is not published', async () => {
    const result = await resolveBaselineAbiAsync(
      CORE_MODULE,
      '99.0.0',
      tempDir(),
      async () => null
    );
    assert.equal(result, null);
  });

  it('returns null for JSI when the tarball has no ABI file', async () => {
    const packageRoot = path.join(tempDir(), 'package');
    fs.mkdirSync(path.join(packageRoot, 'prebuilds/output/headers/xcframeworks'), {
      recursive: true,
    });
    fs.writeFileSync(path.join(packageRoot, 'package.json'), '{}');
    const result = await resolveBaselineAbiAsync(
      JSI_MODULE,
      '58.0.16',
      tempDir(),
      packFrom(packageRoot)
    );
    assert.equal(result, null);
  });

  it('returns the JSI ABI path when the tarball has one', async () => {
    const packageRoot = path.join(tempDir(), 'package');
    const abiDir = path.join(packageRoot, 'prebuilds/abi/ExpoModulesJSI');
    fs.mkdirSync(abiDir, { recursive: true });
    fs.writeFileSync(path.join(abiDir, 'arm64-apple-ios-simulator.abi.json'), '{"jsi":1}');
    const result = await resolveBaselineAbiAsync(
      JSI_MODULE,
      '58.0.17',
      tempDir(),
      packFrom(packageRoot)
    );
    assert.ok(result);
    assert.equal(fs.readFileSync(result, 'utf8'), '{"jsi":1}');
  });

  it('returns the core ABI path inside the extracted xcframework', async () => {
    const staging = tempDir();
    const sliceFile = path.join(staging, 'ExpoModulesCore.xcframework', SLICE_ABI);
    fs.mkdirSync(path.dirname(sliceFile), { recursive: true });
    fs.writeFileSync(sliceFile, '{"core":1}');
    const packageRoot = path.join(tempDir(), 'package');
    const xcframeworks = path.join(packageRoot, 'prebuilds/output/release/xcframeworks');
    fs.mkdirSync(xcframeworks, { recursive: true });
    tar([
      '-czf',
      path.join(xcframeworks, 'ExpoModulesCore.tar.gz'),
      '-C',
      staging,
      'ExpoModulesCore.xcframework',
    ]);
    const result = await resolveBaselineAbiAsync(
      CORE_MODULE,
      '58.0.23',
      tempDir(),
      packFrom(packageRoot)
    );
    assert.ok(result);
    assert.ok(result.endsWith(path.join('ExpoModulesCore.xcframework', SLICE_ABI)), result);
    assert.equal(fs.readFileSync(result, 'utf8'), '{"core":1}');
  });
});
