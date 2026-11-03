import { setTimeout } from 'node:timers/promises'

const [moduleUrl, cwd, root, worker] = process.argv.slice(2)
const { GraphStore } = await import(moduleUrl)
const store = new GraphStore(root, cwd)
for (let index = 0; index < 4; index++) {
  for (let attempt = 0; ; attempt++) {
    try {
      await store.addFact({ description: `${worker}-${index}`, kind: 'note' }, worker)
      break
    } catch (error) {
      if (!error.message.includes('LOCK') || attempt >= 200) throw error
      await setTimeout(10)
    }
  }
}
