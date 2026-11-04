import { defineConfig } from 'tsdown'
import ts from 'typescript'

export default defineConfig([
  {
    entry: { index: 'src/index.ts' },
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2022',
    dts: true,
    clean: false,
    fixedExtension: false,
    external: [/^@deepseek-ai\//, /^node:/],
    // Rolldown can parse TC39 decorators but does not lower them for Node 22/24.
    plugins: [{ name: 'sapper-remote-decorators', transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/src/dsh-adapter/panel.ts')) return
      return { code: ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, verbatimModuleSyntax: true } }).outputText, map: null }
    } }],
  },
  {
    entry: { client: 'src/client/index.tsx' },
    outDir: 'lib',
    format: ['cjs'],
    platform: 'browser',
    target: 'es2022',
    dts: false,
    clean: false,
    fixedExtension: false,
    external: ['react', 'react/jsx-runtime', 'react-dom'],
    noExternal: ['@deepseek-ai/dsh-typert-protocol/remote-info'],
  },
])
