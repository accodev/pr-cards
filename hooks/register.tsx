import type { Register } from 'claude-code'

// Spike placeholder: passes every message through unchanged until PR detection lands.
export const register: Register = (on) => {
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => next(e))
}
