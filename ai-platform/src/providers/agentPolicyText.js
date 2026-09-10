export function agentPolicyText(agent) {
  const sections = [];
  if (agent.systemPrompt) sections.push(agent.systemPrompt);
  if (agent.instructions && Object.keys(agent.instructions).length) sections.push(JSON.stringify({ instructions: agent.instructions }));
  if (Array.isArray(agent.standards) && agent.standards.length) {
    sections.push(JSON.stringify({ standards: agent.standards.map((item) => ({ version: item.version, content: item.content, rules: item.rules })) }));
  }
  return sections.join("\n");
}
