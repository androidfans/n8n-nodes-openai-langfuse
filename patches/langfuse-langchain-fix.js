/**
 * Patch script to fix langfuse-langchain issues:
 * 1. Role extraction: Replace instanceof checks with getType() for cross-package compatibility
 * 2. Prompt linking: Support direct ChatOpenAI calls without chain wrapper
 */

const fs = require('fs');
const path = require('path');

const langfuseLangchainPath = path.join(
  process.argv[2] || '/opt/n8n-custom-nodes/node_modules/langfuse-langchain/lib',
  'index.cjs.js'
);

console.log('Patching langfuse-langchain at:', langfuseLangchainPath);

let content = fs.readFileSync(langfuseLangchainPath, 'utf8');

// ============================================================
// Patch 1: Fix role extraction (instanceof → getType + fallback)
// ============================================================

const oldMethod = `extractChatMessageContent(message) {
    let response = undefined;
    if (message instanceof messages.HumanMessage) {
      response = {
        content: message.content,
        role: "user"
      };
    } else if (message instanceof messages.ChatMessage) {
      response = {
        content: message.content,
        role: message.role
      };
    } else if (message instanceof messages.AIMessage) {
      response = {
        content: message.content,
        role: "assistant"
      };
    } else if (message instanceof messages.SystemMessage) {
      response = {
        content: message.content,
        role: "system"
      };
    } else if (message instanceof messages.FunctionMessage) {
      response = {
        content: message.content,
        additional_kwargs: message.additional_kwargs,
        role: message.name
      };
    } else if (message instanceof messages.ToolMessage) {
      response = {
        content: message.content,
        additional_kwargs: message.additional_kwargs,
        role: message.name
      };
    } else if (!message.name) {
      response = {
        content: message.content
      };
    } else {
      response = {
        role: message.name,
        content: message.content
      };
    }`;

const newMethod = `extractChatMessageContent(message) {
    let response = undefined;
    // Use getType() instead of instanceof to handle cross-package class issues
    const messageType = typeof message.getType === 'function' ? message.getType() : null;
    if (messageType === "human" || message instanceof messages.HumanMessage) {
      response = {
        content: message.content,
        role: "user"
      };
    } else if (messageType === "generic" || message instanceof messages.ChatMessage) {
      response = {
        content: message.content,
        role: message.role || "user"
      };
    } else if (messageType === "ai" || message instanceof messages.AIMessage) {
      response = {
        content: message.content,
        role: "assistant"
      };
    } else if (messageType === "system" || message instanceof messages.SystemMessage) {
      response = {
        content: message.content,
        role: "system"
      };
    } else if (messageType === "function" || message instanceof messages.FunctionMessage) {
      response = {
        content: message.content,
        additional_kwargs: message.additional_kwargs,
        role: message.name || "function"
      };
    } else if (messageType === "tool" || message instanceof messages.ToolMessage) {
      response = {
        content: message.content,
        additional_kwargs: message.additional_kwargs,
        role: message.name || "tool"
      };
    } else if (!message.name) {
      // Fallback: try to determine role from constructor name
      const constructorName = message.constructor?.name;
      if (constructorName === 'SystemMessage') {
        response = { content: message.content, role: "system" };
      } else if (constructorName === 'HumanMessage' || constructorName === 'HumanMessageChunk') {
        response = { content: message.content, role: "user" };
      } else if (constructorName === 'AIMessage' || constructorName === 'AIMessageChunk') {
        response = { content: message.content, role: "assistant" };
      } else {
        response = { content: message.content };
      }
    } else {
      response = {
        role: message.name,
        content: message.content
      };
    }`;

if (content.includes(oldMethod)) {
  content = content.replace(oldMethod, newMethod);
  console.log('Successfully patched extractChatMessageContent method');
} else {
  console.log('Could not find exact extractChatMessageContent method, trying regex...');
  // Try regex replacement for individual instanceof checks
  let patched = false;
  if (content.includes('message instanceof messages.HumanMessage')) {
    content = content.replace(
      /if\s*\(message\s+instanceof\s+messages\.HumanMessage\)/g,
      'if ((typeof message.getType === "function" ? message.getType() : null) === "human" || message instanceof messages.HumanMessage)'
    );
    content = content.replace(
      /else\s+if\s*\(message\s+instanceof\s+messages\.ChatMessage\)/g,
      'else if ((typeof message.getType === "function" ? message.getType() : null) === "generic" || message instanceof messages.ChatMessage)'
    );
    content = content.replace(
      /else\s+if\s*\(message\s+instanceof\s+messages\.AIMessage\)/g,
      'else if ((typeof message.getType === "function" ? message.getType() : null) === "ai" || message instanceof messages.AIMessage)'
    );
    content = content.replace(
      /else\s+if\s*\(message\s+instanceof\s+messages\.SystemMessage\)/g,
      'else if ((typeof message.getType === "function" ? message.getType() : null) === "system" || message instanceof messages.SystemMessage)'
    );
    content = content.replace(
      /else\s+if\s*\(message\s+instanceof\s+messages\.FunctionMessage\)/g,
      'else if ((typeof message.getType === "function" ? message.getType() : null) === "function" || message instanceof messages.FunctionMessage)'
    );
    content = content.replace(
      /else\s+if\s*\(message\s+instanceof\s+messages\.ToolMessage\)/g,
      'else if ((typeof message.getType === "function" ? message.getType() : null) === "tool" || message instanceof messages.ToolMessage)'
    );
    patched = true;
    console.log('Successfully patched using regex approach');
  }
  if (!patched) {
    throw new Error('FATAL: Could not patch extractChatMessageContent – langfuse-langchain source may have changed');
  }
}

// ============================================================
// Patch 2: Fix prompt linking for direct ChatOpenAI calls
// ============================================================

const oldPromptCode = `const registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");
    if (registeredPrompt && parentRunId) {
      this.deregisterLangfusePrompt(parentRunId);
    }
    this.langfuse.generation({`;

const newPromptCode = `let registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");
    // Also check metadata for langfusePrompt (for direct ChatOpenAI calls without chain)
    if (!registeredPrompt && metadata && "langfusePrompt" in metadata) {
      registeredPrompt = metadata.langfusePrompt;
    }
    if (registeredPrompt && parentRunId) {
      this.deregisterLangfusePrompt(parentRunId);
    }
    this.langfuse.generation({`;

if (content.includes(oldPromptCode)) {
  content = content.replace(oldPromptCode, newPromptCode);
  console.log('Successfully patched prompt linking for direct model calls');
} else {
  // Try alternative pattern
  const altPattern = /const registeredPrompt = this\.promptToParentRunMap\.get\(parentRunId \?\? "root"\);\s*if \(registeredPrompt && parentRunId\) \{\s*this\.deregisterLangfusePrompt\(parentRunId\);\s*\}\s*this\.langfuse\.generation\(\{/;
  if (altPattern.test(content)) {
    content = content.replace(altPattern, newPromptCode);
    console.log('Successfully patched prompt linking using regex');
  } else {
    throw new Error('FATAL: Could not patch prompt linking – langfuse-langchain source may have changed');
  }
}

// ============================================================
// Patch 3: Fix generateTrace – don't overwrite root trace name
// When updateRoot is true, only update input, not name/userId/sessionId/tags
// (those are already set when creating the root trace)
// ============================================================

const oldGenerateTraceUpdateRoot = `    if (this.rootProvided && this.updateRoot) {
      if (this.rootObservationId) {
        this.langfuse._updateSpan({
          id: this.rootObservationId,
          traceId: this.traceId,
          ...params
        });
      } else {
        this.langfuse.trace({
          id: this.traceId,
          ...params
        });
      }
    }`;

const newGenerateTraceUpdateRoot = `    if (this.rootProvided && this.updateRoot) {
      // Only update input on root trace, preserve name/userId/sessionId/tags
      if (this.rootObservationId) {
        this.langfuse._updateSpan({
          id: this.rootObservationId,
          traceId: this.traceId,
          input: input
        });
      } else {
        this.langfuse.trace({
          id: this.traceId,
          input: input
        });
      }
    }`;

if (content.includes(oldGenerateTraceUpdateRoot)) {
  content = content.replace(oldGenerateTraceUpdateRoot, newGenerateTraceUpdateRoot);
  console.log('Successfully patched generateTrace to preserve root trace name');
} else {
  throw new Error('FATAL: Could not patch generateTrace updateRoot block – langfuse-langchain source may have changed');
}

// ============================================================
// Patch 4: Fix updateTrace – only update root output for LLM end
// Add updateRootOutput parameter to updateTrace, and only pass true from handleLLMEnd.
// This prevents tool/retriever/chain/error handlers from overwriting root output.
// ============================================================

// 4a: Change updateTrace signature and guard the root output block
const oldUpdateTrace = `  updateTrace(runId, parentRunId, output) {
    const traceUpdates = this.traceUpdates.get(runId);
    this.traceUpdates.delete(runId);
    if (!parentRunId && this.traceId && this.traceId === runId) {
      this.langfuse.trace({
        id: this.traceId,
        output: output,
        ...traceUpdates
      });
    }
    if (!parentRunId && this.traceId && this.rootProvided && this.updateRoot) {
      if (this.rootObservationId) {
        this.langfuse._updateSpan({
          id: this.rootObservationId,
          traceId: this.traceId,
          output
        });
      } else {
        this.langfuse.trace({
          id: this.traceId,
          output,
          ...traceUpdates
        });
      }
    }
  }`;

const newUpdateTrace = `  updateTrace(runId, parentRunId, output, updateRootOutput) {
    const traceUpdates = this.traceUpdates.get(runId);
    this.traceUpdates.delete(runId);
    if (!parentRunId && this.traceId && this.traceId === runId) {
      this.langfuse.trace({
        id: this.traceId,
        output: output,
        ...traceUpdates
      });
    }
    if (updateRootOutput && this.traceId && this.rootProvided && this.updateRoot) {
      if (this.rootObservationId) {
        this.langfuse._updateSpan({
          id: this.rootObservationId,
          traceId: this.traceId,
          output
        });
      } else {
        this.langfuse.trace({
          id: this.traceId,
          output
        });
      }
    }
  }`;

if (content.includes(oldUpdateTrace)) {
  content = content.replace(oldUpdateTrace, newUpdateTrace);
  console.log('Successfully patched updateTrace signature and root output guard');
} else {
  throw new Error('FATAL: Could not patch updateTrace method – langfuse-langchain source may have changed');
}

// 4b: In handleLLMEnd, pass true as the 4th argument to updateTrace
const oldLLMEndUpdateTrace = `      this.updateTrace(runId, parentRunId, extractedOutput);`;
const newLLMEndUpdateTrace = `      this.updateTrace(runId, parentRunId, extractedOutput, true);`;

if (content.includes(oldLLMEndUpdateTrace)) {
  content = content.replace(oldLLMEndUpdateTrace, newLLMEndUpdateTrace);
  console.log('Successfully patched handleLLMEnd to pass updateRootOutput=true');
} else {
  throw new Error('FATAL: Could not patch handleLLMEnd updateTrace call – langfuse-langchain source may have changed');
}

fs.writeFileSync(langfuseLangchainPath, content);
console.log('Patch complete!');
