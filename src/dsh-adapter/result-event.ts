import { pluginRecordOf, type SessionEvent } from '@deepseek-ai/dsh-session'
import { RESULT_RECORD } from '../panel/result.js'
import { readResult } from '../panel/result-schema.js'
export function resultOfEvent(event: SessionEvent) {
  const record = pluginRecordOf(event)
  return record?.type === RESULT_RECORD
    ? readResult(record.data)
    : event.type === 'sapper/result'
      ? readResult(event.data)
      : undefined
}
