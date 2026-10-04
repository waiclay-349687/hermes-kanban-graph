import { build } from 'esbuild'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(entry => {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) return sourceFiles(path)
    return /\.(?:ts|tsx)$/.test(entry.name) ? [path] : []
  }))
  return nested.flat()
}

const sourceEntries = await sourceFiles('src')
const sourceText = (await Promise.all(sourceEntries.map(path => readFile(path, 'utf8')))).join('\n')
const forbiddenPortals = ['NodeToolbar', 'EdgeToolbar', 'EdgeLabelRenderer', 'ViewportPortal']
  .filter(name => sourceText.includes(name))
if (forbiddenPortals.length) throw new Error(`React Flow portal APIs are unsupported: ${forbiddenPortals.join(', ')}`)

const sanitizeXyflowLoaderText = {
  name: 'sanitize-xyflow-loader-text',
  setup(build) {
    build.onLoad({ filter: /node_modules[\\/]@xyflow[\\/]system[\\/].*\.m?js$/ }, async args => ({
      contents: (await readFile(args.path, 'utf8')).replaceAll("Please import '@xyflow/", "Please load '@xyflow/"),
      loader: 'js'
    }))
  }
}

const bridgeCjsReactToHost = {
  name: 'bridge-cjs-react-to-host',
  setup(build) {
    build.onResolve({ filter: /^react$/ }, args =>
      args.kind === 'require-call' ? { path: 'react-cjs-bridge', namespace: 'hermes-host' } : undefined
    )
    build.onLoad({ filter: /^react-cjs-bridge$/, namespace: 'hermes-host' }, () => ({
      contents: 'export * from "react"; import React from "react"; export default React',
      loader: 'js'
    }))
  }
}

const result = await build({
  entryPoints: ['src/plugin.tsx'],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'es2022',
  minify: true,
  splitting: false,
  treeShaking: true,
  define: { 'process.env.NODE_ENV': '"production"' },
  sourcemap: true,
  legalComments: 'eof',
  external: ['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'],
  alias: { 'react-dom': './src/react-dom-stub.ts' },
  plugins: [sanitizeXyflowLoaderText, bridgeCjsReactToHost],
  loader: { '.css': 'text' },
  outfile: 'dist/plugin.js',
  metafile: true
})

await mkdir('dist', { recursive: true })
const source = await readFile('dist/plugin.js', 'utf8')
const runtimeImportRe = () => /(from\s*|import\s*\(\s*|import\s+)(['"])([^'"]+)\2/g
const runtimeAllowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'])
const runtimeUnsupported = [...source.matchAll(runtimeImportRe())]
  .map(match => match[3])
  .filter(specifier => !/^[./]/.test(specifier) && !/^[a-z][a-z0-9+.-]*:/i.test(specifier) && !runtimeAllowed.has(specifier))
if (runtimeUnsupported.length) throw new Error(`Hermes runtime scanner would reject: ${[...new Set(runtimeUnsupported)].join(', ')}`)
if (source.includes('Dynamic require of')) throw new Error('bundle contains a dynamic require helper')
const externalImports = Object.values(result.metafile.outputs)
  .flatMap(output => output.imports)
  .filter(item => item.external)
  .map(item => item.path)
const allowed = new Set(['@hermes/plugin-sdk', 'react', 'react/jsx-runtime', 'react/jsx-dev-runtime'])
const unsupported = externalImports.filter(specifier => !allowed.has(specifier))
if (unsupported.length) throw new Error(`unsupported runtime imports: ${[...new Set(unsupported)].join(', ')}`)
const bundledReact = Object.keys(result.metafile.inputs).filter(path => /node_modules\/(react|react-dom)\//.test(path))
if (bundledReact.length) throw new Error(`host React was bundled: ${bundledReact.join(', ')}`)
await writeFile('dist/meta.json', JSON.stringify(result.metafile, null, 2))
console.log(`built dist/plugin.js (${Buffer.byteLength(source)} bytes)`)
