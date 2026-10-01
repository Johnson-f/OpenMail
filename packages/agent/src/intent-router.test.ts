import { describe, expect, it } from 'vitest'
import { classifyIntent, type AssistantIntent } from './intent-router'

const CASES: Array<[string, AssistantIntent]> = [
  ['Hey', 'conversation'],
  ['hello!', 'conversation'],
  ['Thanks', 'conversation'],
  ['good morning', 'conversation'],
  ['thank you!', 'conversation'],
  ['How are you?', 'conversation'],
  ['What can you do?', 'conversation'],
  ['Explain how compound interest works', 'conversation'],
  ['What is a mortgage?', 'conversation'],
  ['Tell me about the French Revolution', 'conversation'],
  ['What did Alice say about the renewal?', 'mail_question'],
  ['When did Bob send the contract?', 'mail_question'],
  ['Did Alice reply?', 'mail_question'],
  ['Did Bob forward the invoice to accounting?', 'mail_question'],
  ['Who sent me the draft?', 'mail_question'],
  ['Has anyone replied to my proposal?', 'mail_question'],
  ['Was the report deleted?', 'mail_question'],
  ['what did the label say about pricing', 'mail_question'],
  ['Which emails did I mark as important last week?', 'mail_question'],
  ['Is the draft from Sam still waiting?', 'mail_question'],
  ['Where did Carol say the meeting is?', 'mail_question'],
  ['Find emails about invoice 3817', 'mail_question'],
  ['Show messages from bob@example.com', 'mail_question'],
  ['Can you find the invoice from Acme', 'mail_question'],
  ['Search for the flight confirmation', 'mail_question'],
  ['Did we agree on a price?', 'mail_question'],
  ['Why did the label change?', 'mail_question'],
  ['Does the contract mention a send date?', 'mail_question'],
  ['Draft an email to Alice about the renewal', 'action_request'],
  ['Send Bob a reply saying yes', 'action_request'],
  ['Archive these messages', 'action_request'],
  ['Can you send Bob the deck', 'action_request'],
  ['archive these', 'action_request'],
  ['draft a reply to Sam saying yes', 'action_request'],
  ['Please forward the invoice to accounting', 'action_request'],
  ['Could you please delete that email', 'action_request'],
  ['Would you mark them as read', 'action_request'],
  ['Label this thread as Receipts', 'action_request'],
  ['star it', 'action_request'],
  ['Trash the newsletter emails', 'action_request'],
  ['Reply to Alice and say thanks', 'action_request'],
  ['Write an email to Dana about the delay', 'action_request'],
  ['Move this to trash', 'action_request'],
  ['Compose a message to the team', 'action_request'],
  ['archive them', 'action_request'],
  ['Write me a poem about autumn and falling leaves', 'conversation'],
]

describe('classifyIntent', () => {
  it('has a broad phrase table', () => {
    expect(CASES.length).toBeGreaterThanOrEqual(40)
  })

  it.each(CASES)('routes %j as %s', (input, expected) => {
    expect(classifyIntent(input)).toBe(expected)
  })
})
