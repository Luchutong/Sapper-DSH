import { readFile, writeFile, unlink } from 'node:fs/promises'

// DSH executes this file as a classic script. Registration itself must be lazy:
// all generated module code, including require('react'), stays in the factory.
const file = new URL('../lib/client.js', import.meta.url)
const raw = new URL('../lib/client.cjs', import.meta.url)
const code = await readFile(raw, 'utf8')
await writeFile(file,
    'window.__ModuleLoader__.load({\n' +
    '  id: "sapper-dsh",\n' +
    '  factory: (require) => {\n' +
    '    var module = { exports: {} };\n' +
    '    var exports = module.exports;\n' + code +
    '\n    return module.exports;\n  }\n});\n',
    'utf8',
)
await unlink(raw)
