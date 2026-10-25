// Labels for sessions that tools start through the Agent SDK, matched on the first prompt.
// Only the label ever reaches the report; prompt text never does.
// To add a tool: append { label, test } where test matches the start of the prompt it sends.
export const SDK_SESSION_SIGNATURES = [
  { label: 'security-guidance review', test: /^Review this change for security vulnerabilities/ },
];

export function labelForPrompt(text) {
  const t = String(text || '').trimStart();
  for (const s of SDK_SESSION_SIGNATURES) if (s.test.test(t)) return s.label;
  return null;
}
