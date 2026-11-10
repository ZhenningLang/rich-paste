// Regression guard (dogfood report 2026-11-06): every name desktop/plugin.js imports from
// @hermes/plugin-sdk must really be exported by Hermes Desktop, and the test mock must not
// invent names the real SDK lacks. Three checks:
//   1. the SDK source (apps/desktop/src/sdk/index.ts + its `export *` modules);
//   2. the export list of the Desktop build that actually runs (release bundle), if present;
//   3. link desktop/plugin.js through shims built from that export list — the same
//      `export const { …names } = sdk` shape the runtime loader uses — and run register().
// Missing Hermes source / build → the check is skipped with the reason printed.
import assert from 'node:assert/strict'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))
const hermes = process.env.HERMES_AGENT_DIR || join(homedir(), '.hermes', 'hermes-agent')
const sdkIndex = join(hermes, 'apps/desktop/src/sdk/index.ts')
const releaseAssets = join(hermes, 'apps/desktop/release/mac-arm64/Hermes.app/Contents/Resources/app.asar.unpacked/dist/assets')

const bundle = readFileSync(join(root, 'desktop/plugin.js'), 'utf8')

/** Named imports per specifier from an ESM text (`import { a, b as c } from "x"`). */
export function namedImports(code: string): Record<string, string[]> {
  const out: Record<string, string[]> = {}
  for (const m of code.matchAll(/import\s*\{([^}]*)\}\s*from\s*["']([^"']+)["']/g)) {
    const names = m[1].split(',').map(part => part.trim().split(/\s+as\s+/)[0].trim()).filter(Boolean)
    ;(out[m[2]] ||= []).push(...names)
  }
  return out
}

/** Runtime export names of a TS module, following `export * from './x'` inside the SDK dir. */
function exportedNames(file: string, seen = new Set<string>()): Set<string> {
  const names = new Set<string>()
  if (seen.has(file) || !existsSync(file)) return names
  seen.add(file)
  const code = readFileSync(file, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  for (const m of code.matchAll(/export\s+(?!type\b)\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const entry = part.trim()
      if (!entry || entry.startsWith('type ')) continue
      const [, alias] = entry.split(/\s+as\s+/)
      names.add((alias ?? entry).trim())
    }
  }
  for (const m of code.matchAll(/export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/g)) names.add(m[1])
  for (const m of code.matchAll(/export\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from/g)) names.add(m[1])
  for (const m of code.matchAll(/export\s+\*\s+from\s+["'](\.[^"']+)["']/g)) {
    const base = join(dirname(file), m[1])
    const target = [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts')].find(existsSync)
    if (target) for (const name of exportedNames(target, seen)) names.add(name)
  }
  return names
}

/** Export keys of the SDK namespace in the built renderer (`{…,NAME:()=>x,…}` export map). */
function builtExportNames(): Set<string> | null {
  if (!existsSync(releaseAssets)) return null
  for (const file of readdirSync(releaseAssets).filter(f => f.endsWith('.js'))) {
    const code = readFileSync(join(releaseAssets, file), 'utf8')
    const at = code.indexOf('SETTINGS_PLUGINS_AREA:()=>')
    if (at < 0) continue
    const segment = code.slice(code.lastIndexOf('({', at), code.indexOf('})', at))
    return new Set([...segment.matchAll(/([A-Za-z_$][\w$]*):\(\)=>/g)].map(m => m[1]))
  }
  return null
}

const imports = namedImports(bundle)
const sdkNames = imports['@hermes/plugin-sdk'] ?? []

test('desktop/plugin.js only imports the three allowed specifiers', () => {
  assert.deepEqual(Object.keys(imports).sort(), ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime'])
  assert.ok(sdkNames.length > 0)
})

test('every @hermes/plugin-sdk import is exported by the SDK source', t => {
  if (!existsSync(sdkIndex)) return t.skip(`SDK source not found: ${sdkIndex}`)
  const real = exportedNames(sdkIndex)
  assert.ok(real.size > 50, `parsed only ${real.size} SDK exports — parser broken?`)
  assert.deepEqual(sdkNames.filter(n => !real.has(n)), [], `imported but not exported by ${sdkIndex}`)
})

test('the test mock exports no name the real SDK lacks', t => {
  if (!existsSync(sdkIndex)) return t.skip(`SDK source not found: ${sdkIndex}`)
  const real = exportedNames(sdkIndex)
  const mock = readFileSync(new URL('./mocks/sdk.ts', import.meta.url), 'utf8')
  const mockNames = [...mock.matchAll(/^export\s+(?:const|function)\s+([A-Za-z_$][\w$]*)/gm)].map(m => m[1])
  assert.ok(mockNames.length > 0)
  assert.deepEqual(mockNames.filter(n => !real.has(n)), [], 'mock-only names would hide a missing SDK export')
})

test('every @hermes/plugin-sdk import is exported by the Desktop build that runs', t => {
  const built = builtExportNames()
  if (!built) return t.skip(`no Desktop release build under ${releaseAssets}`)
  assert.ok(built.size > 50, `parsed only ${built.size} built exports`)
  assert.deepEqual(sdkNames.filter(n => !built.has(n)), [], 'imported but missing from the running Desktop build')
})

test('desktop/plugin.js links through loader-style shims of the built export list and register() runs', async t => {
  const built = builtExportNames() ?? (existsSync(sdkIndex) ? exportedNames(sdkIndex) : null)
  if (!built) return t.skip('neither a Desktop build nor the SDK source is available')
  const g = globalThis as Record<string, any>
  const atomOf = (value: unknown) => ({ get: () => value, set: (v: unknown) => { value = v }, listen: () => () => {}, subscribe: () => () => {} })
  g.__rpSdk = Object.fromEntries([...built].map(n => [n, undefined]))
  Object.assign(g.__rpSdk, {
    atom: atomOf, useValue: (a: { get: () => unknown }) => a.get(),
    COMPOSER_AREAS: { top: 'composer.top', underside: 'composer.underside', middleware: 'composer.middleware' },
    SETTINGS_PLUGINS_AREA: 'settings.plugins',
    host: { state: { focusedSessionId: atomOf(null) }, notify() {}, composer: {} }
  })
  g.__rpReact = { useState: (v: unknown) => [v, () => {}], useEffect() {} }
  g.__rpJsx = { jsx: (type: unknown, props: unknown) => ({ type, props }), jsxs: (type: unknown, props: unknown) => ({ type, props }) }
  const shim = (globalKey: string, names: string[]) =>
    'data:text/javascript,' + encodeURIComponent(`const m = globalThis.${globalKey};\nexport const { ${names.join(', ')} } = m;\n`)
  const linked = bundle
    .replace('"@hermes/plugin-sdk"', JSON.stringify(shim('__rpSdk', [...built])))
    .replace('"react/jsx-runtime"', JSON.stringify(shim('__rpJsx', ['jsx', 'jsxs'])))
    .replace('"react"', JSON.stringify(shim('__rpReact', ['useState', 'useEffect'])))
  g.document ??= Object.assign(new EventTarget(), { visibilityState: 'visible', activeElement: null })
  const mod = await import('data:text/javascript;base64,' + Buffer.from(linked).toString('base64'))
  assert.equal(mod.default.id, 'rich-paste')
  const registered: string[] = []
  const noop = () => () => {}
  mod.default.register({
    storage: { get: (_k: string, fb: unknown) => fb, set() {} },
    rest: async () => ({}), register: (c: { id: string }) => { registered.push(c.id); return () => {} },
    registerSettingsPage: (p: { id: string }) => { registered.push(`page:${p.id}`); return () => {} },
    addEventListener: noop, setTimeout: noop, setInterval: noop, os: { revealPath: async () => true }
  })
  assert.deepEqual(registered.sort(), ['attach-markers', 'audio', 'busy-bar', 'hint', 'long-paste', 'md-preview', 'more-images', 'page:settings', 'split', 'strip', 'tip'])
})
