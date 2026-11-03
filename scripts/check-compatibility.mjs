import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { evaluatePluginCompatibility, getDshRuntimeVersion, pluginCompatibilityWarning } from '@deepseek-ai/dsh-app-boot'

const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))
const runtime = process.argv[2] ?? getDshRuntimeVersion()
const issue = evaluatePluginCompatibility(manifest, {}, runtime)
if (issue) throw new Error(pluginCompatibilityWarning(issue))
for (const name of ['dsh-agent', 'dsh-llm', 'dsh-settings', 'dsh-tools']) {
  const key = `@deepseek-ai/${name}`
  assert.equal(manifest.peerDependencies[key], manifest.devDependencies[key], `${key}: peer/test SDK drift`)
}
console.log(`Compatibility gate passed: ${manifest.name}@${manifest.version} on DSH ${runtime}; no exemptions.`)
