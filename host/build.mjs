// Builds jelly-host with CMake + Ninja + Clang. On Windows it runs inside a vcvars64 environment so clang-cl
// finds the MSVC libraries and the Windows SDK, then builds jelly-bridge32 (the 32-bit plugin bridge) in a vcvars32
// one, reusing the sources the first build fetched. Usage: node host/build.mjs [Release|Debug]
import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const config = process.argv[2] || 'Release';
const build = path.join(here, 'build', config.toLowerCase());

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: 'inherit', ...opts });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

if (process.platform === 'win32') {
  const vswhere = path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  const vs = execFileSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' }).trim();
  const vcvars = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat');
  const vcvars32 = path.join(vs, 'VC', 'Auxiliary', 'Build', 'vcvars32.bat');
  const llvm = process.env.LLVM_BIN || 'C:\\Program Files\\LLVM\\bin';
  const clang = path.join(llvm, 'clang-cl.exe');
  if (!fs.existsSync(clang)) throw new Error(`clang-cl not found at ${clang} (set LLVM_BIN)`);
  const q = (s) => `"${s}"`;
  const configure = [
    'cmake', '-S', q(here), '-B', q(build), '-G', 'Ninja', `-DCMAKE_BUILD_TYPE=${config}`,
    `-DCMAKE_C_COMPILER=${q(clang)}`, `-DCMAKE_CXX_COMPILER=${q(clang)}`,
    `-DCMAKE_LINKER=${q(path.join(llvm, 'lld-link.exe'))}`, `-DCMAKE_RC_COMPILER=rc`,
  ].join(' ');
  const build32 = build + '-x86';
  const deps = path.join(build, '_deps');
  const configure32 = [
    'cmake', '-S', q(here), '-B', q(build32), '-G', 'Ninja', `-DCMAKE_BUILD_TYPE=${config}`,
    `-DCMAKE_C_COMPILER=${q(clang)}`, `-DCMAKE_CXX_COMPILER=${q(clang)}`,
    '-DCMAKE_C_COMPILER_TARGET=i686-pc-windows-msvc', '-DCMAKE_CXX_COMPILER_TARGET=i686-pc-windows-msvc',
    `-DCMAKE_LINKER=${q(path.join(llvm, 'lld-link.exe'))}`, `-DCMAKE_RC_COMPILER=rc`,
    '-DJELLY_BRIDGE32=ON', '-DJELLY_ASIO=OFF',
    `-DFETCHCONTENT_SOURCE_DIR_JUCE=${q(path.join(deps, 'juce-src'))}`, `-DFETCHCONTENT_SOURCE_DIR_FST=${q(path.join(deps, 'fst-src'))}`,
  ].join(' ');
  // each build in a cmd of its own: vcvars64 and vcvars32 in one would mix their library paths
  const steps = [
    ['build.cmd', `call ${q(vcvars)} >nul && ${configure} && cmake --build ${q(build)} --config ${config}`],
    // JUCE configures its juceaide tool in a nested CMake that only sees the environment: give it the x86 target too
    ['build32.cmd', `call ${q(vcvars32)} >nul && set "CC=${clang}" && set "CXX=${clang}" && ` +
      `set "CFLAGS=--target=i686-pc-windows-msvc" && set "CXXFLAGS=--target=i686-pc-windows-msvc" && ` +
      `${configure32} && cmake --build ${q(build32)} --config ${config}`],
  ];
  for (const [file, script] of steps) {
    const bat = path.join(build, '..', file);
    fs.mkdirSync(path.dirname(bat), { recursive: true });
    fs.writeFileSync(bat, `@echo off\r\n${script}\r\n`);
    run('cmd.exe', ['/d', '/c', bat]);
  }
} else {
  run('cmake', ['-S', here, '-B', build, '-G', 'Ninja', `-DCMAKE_BUILD_TYPE=${config}`, '-DCMAKE_C_COMPILER=clang', '-DCMAKE_CXX_COMPILER=clang++']);
  run('cmake', ['--build', build]);
}
