import type { Action, Tool, ToolRegistry } from './types.js';

export class Actor {
  constructor(private readonly registry: ToolRegistry) {}

  async act(action: Action): Promise<string> {
    const tool = this.registry.byName(action.tool);
    if (!tool) {
      throw new Error(`Tool "${action.tool}" not found. Registered tools: ${this.registry.tools.map((t) => t.name).join(', ')}`);
    }
    return tool.execute(action.input);
  }
}

export class DirectToolActor {
  constructor(private readonly tools: Tool[]) {}

  async act(action: Action): Promise<string> {
    const tool = this.tools.find((t) => t.name === action.tool);
    if (!tool) {
      throw new Error(`Tool "${action.tool}" not found. Registered tools: ${this.tools.map((t) => t.name).join(', ')}`);
    }
    return tool.execute(action.input);
  }
}

export { ShellTool } from './tools.js';
