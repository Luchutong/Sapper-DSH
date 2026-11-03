import { evaluatePluginCompatibility, getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import { describe, expect, it } from 'vitest'
import manifest from '../package.json'
import { SDK_VERSION, VERSION } from '../src/constants.js'

const sdkPeers = ['@deepseek-ai/dsh-agent', '@deepseek-ai/dsh-llm', '@deepseek-ai/dsh-settings', '@deepseek-ai/dsh-tools'] as const

describe('official DSH installation compatibility gate', () => {
  it('reproduces the alpha.1 rejection without granting exemptions', () => {
    const previous = { ...manifest, version: '0.1.0-alpha.1', peerDependencies: Object.fromEntries(sdkPeers.map(name => [name, '0.1.5-rc.1'])) }
    expect(evaluatePluginCompatibility(previous, {}, '0.2.1-rc.2')).toMatchObject({
      version: '0.1.0-alpha.1', runtimeVersion: '0.2.1-rc.2', exempted: false,
      requirements: Object.fromEntries(sdkPeers.map(name => [name, '0.1.5-rc.1'])),
    })
  })

  it('accepts the new manifest against the SDK actually used by the tests', () => {
    expect(getDshRuntimeVersion()).toBe(SDK_VERSION)
    expect(evaluatePluginCompatibility(manifest, {}, SDK_VERSION)).toBeUndefined()
    expect(manifest.version).toBe(VERSION)
    expect(manifest.devDependencies['@deepseek-ai/dsh-app-boot']).toBe(SDK_VERSION)
    for (const name of sdkPeers) {
      expect(manifest.peerDependencies[name]).toBe(SDK_VERSION)
      expect(manifest.devDependencies[name]).toBe(SDK_VERSION)
    }
    expect(manifest.engines).not.toHaveProperty('dsh')
  })

  it('does not declare untested old or future SDKs compatible', () => {
    expect(evaluatePluginCompatibility(manifest, {}, '0.1.5-rc.1')?.exempted).toBe(false)
    expect(evaluatePluginCompatibility(manifest, {}, '0.2.1-rc.3')?.exempted).toBe(false)
  })
})
