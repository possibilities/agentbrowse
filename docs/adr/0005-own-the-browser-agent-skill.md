# 0005: Let Agentbrowse own the browser agent skill

Agentbrowse owns the fleet's `browser` skill because it defines the durable
provider, target-resolution, and human-handoff semantics around agent-browser.
The skill loads agent-browser's bundled, version-matched core guide instead of
copying its command surface; Agentweb retains only its legacy runtime contract
while consumers migrate.
