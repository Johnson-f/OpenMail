export type AssistantIntent = 'conversation' | 'mail_question' | 'action_request'

const SMALL_TALK = /^(?:hey|hi|hello|good\s+(?:morning|afternoon|evening)|thanks|thank\s+you|bye|goodbye|how\s+are\s+you|what\s+can\s+you\s+do)[\s!?.]*$/i
const COMMAND_PREFIX = /^(?:(?:please|kindly)\s+)?(?:(?:can|could|would|will)\s+you\s+(?:(?:please|kindly)\s+)?)?/i
const ACTION_VERB = /^(?:draft|compose|send|reply|respond|forward|archive|unarchive|trash|delete|remove|label|unlabel|star|unstar|mark|move|restore)\b/i
const WRITE_MESSAGE = /^write\b[\s\S]*\b(?:email|e-mail|mail|message|reply|note)\b/i
const QUESTION_START = /^(?:who|whom|whose|what|when|where|which|why|how|did|do|does|is|are|was|were|has|have|had|can|could|would|will|should|shall|may)\b/i
const MAIL_QUESTION = /(?:\b(?:email|emails|mail|inbox|message|messages|thread|threads|attachment|attachments|sent|sender)\b|\b(?:did|have)\s+(?:we|i)\b|\bwe\s+(?:agreed|decided|discussed)\b|\bfind\b|\bsearch\b|\bshow\s+me\b|\baccording\s+to\b|\bconversation\s+with\b)/i
const GENERAL_QUESTION = /^(?:explain|define|tell\s+me\s+(?:a|about)|how\s+(?:does|do|is|are)|what\s+(?:is|are)|who\s+is|why\s+(?:is|are|does|do))\b/i

function isCommand(input: string): boolean {
  const command = input.replace(COMMAND_PREFIX, '')
  return ACTION_VERB.test(command) || WRITE_MESSAGE.test(command)
}

export function classifyIntent(input: string): AssistantIntent {
  const normalized = input.trim()
  if (SMALL_TALK.test(normalized)) return 'conversation'
  if (isCommand(normalized)) return 'action_request'
  if (MAIL_QUESTION.test(normalized)) return 'mail_question'
  if (GENERAL_QUESTION.test(normalized)) return 'conversation'
  if (QUESTION_START.test(normalized) || normalized.endsWith('?')) return 'mail_question'
  return normalized.split(/\s+/).length <= 4 ? 'mail_question' : 'conversation'
}
