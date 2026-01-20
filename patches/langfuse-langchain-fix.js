/**
 * Patch script to fix langfuse-langchain extractChatMessageContent method
 * This replaces instanceof checks with getType() checks to handle cross-package class issues
 */

const fs = require('fs');
const path = require('path');

const langfuseLangchainPath = path.join(
  process.argv[2] || '/opt/n8n-custom-nodes/node_modules/langfuse-langchain/lib',
  'index.cjs.js'
);

console.log('Patching langfuse-langchain at:', langfuseLangchainPath);

let content = fs.readFileSync(langfuseLangchainPath, 'utf8');

// Replace the extractChatMessageContent method
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
      // Fallback: try to determine role from constructor name or default to content only
      const constructorName = message.constructor?.name;
      if (constructorName === 'SystemMessage') {
        response = { content: message.content, role: "system" };
      } else if (constructorName === 'HumanMessage') {
        response = { content: message.content, role: "user" };
      } else if (constructorName === 'AIMessage') {
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
  console.log('Could not find the exact method to patch, trying alternative approach...');

  // Alternative: use regex to find and replace
  const regex = /extractChatMessageContent\(message\)\s*\{[\s\S]*?if\s*\(message\s+instanceof\s+messages\.HumanMessage\)/;
  if (regex.test(content)) {
    // Replace instanceof checks with getType() checks throughout the method
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

    console.log('Successfully patched using regex approach');
  } else {
    console.error('Failed to find extractChatMessageContent method to patch');
    process.exit(1);
  }
}

// Patch 2: Fix prompt linking for handleChatModelStart/handleGenerationStart
// The original code only registers prompt in handleChainStart, but when using ChatOpenAI directly,
// handleChatModelStart is called without a prior handleChainStart, so prompt is never registered.
// We need to also check for langfusePrompt in the metadata passed to handleGenerationStart.

const oldHandleGenerationStart = `const registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");
    if (registeredPrompt && parentRunId) {
      this.deregisterLangfusePrompt(parentRunId);
    }
    this.langfuse.generation({`;

const newHandleGenerationStart = `let registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");
    // Also check metadata for langfusePrompt (for direct ChatOpenAI calls without chain)
    if (!registeredPrompt && metadata && "langfusePrompt" in metadata) {
      registeredPrompt = metadata.langfusePrompt;
    }
    if (registeredPrompt && parentRunId) {
      this.deregisterLangfusePrompt(parentRunId);
    }
    this.langfuse.generation({`;

if (content.includes(oldHandleGenerationStart)) {
  content = content.replace(oldHandleGenerationStart, newHandleGenerationStart);
  console.log('Successfully patched handleGenerationStart for prompt linking');
} else {
  // Try alternative pattern (minified version may have different spacing)
  const altOldPattern = /const registeredPrompt = this\.promptToParentRunMap\.get\(parentRunId \?\? "root"\);\s*if \(registeredPrompt && parentRunId\) \{\s*this\.deregisterLangfusePrompt\(parentRunId\);\s*\}\s*this\.langfuse\.generation\(\{/;
  if (altOldPattern.test(content)) {
    content = content.replace(altOldPattern, newHandleGenerationStart);
    console.log('Successfully patched handleGenerationStart using regex');
  } else {
    console.log('Warning: Could not patch handleGenerationStart for prompt linking');
  }
}

fs.writeFileSync(langfuseLangchainPath, content);
console.log('Patch complete!');
