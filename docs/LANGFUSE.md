# Langfuse 集成问题与解决方案

本文档记录了 n8n-nodes-openai-langfuse 项目中 Langfuse 集成遇到的问题及其解决方案。

## 目录

- [问题概述](#问题概述)
- [问题 1: 消息 Role 字段缺失](#问题-1-消息-role-字段缺失)
- [问题 2: Prompt 关联失败](#问题-2-prompt-关联失败)
- [为什么 Python SDK 没有这些问题](#为什么-python-sdk-没有这些问题)
- [为什么不能升级到 @langfuse/langchain@4.x](#为什么不能升级到-langfuselangchain4x)
- [具体修复实现](#具体修复实现)
- [长期维护建议](#长期维护建议)

---

## 问题概述

在 n8n 中使用 `langfuse-langchain` 集成时，发现两个问题：

1. **消息 Role 字段缺失**：上报到 Langfuse 的 trace 中，消息只有 `content` 没有 `role`
2. **Prompt 关联失败**：配置了 Prompt Name 和 Version，但无法关联到 Langfuse 的 Prompt

对比 Python SDK 的正常输出：
```json
// Python SDK (正常)
[
  {"role": "system", "content": "You are a helpful assistant"},
  {"role": "user", "content": "Hello"}
]

// n8n + langfuse-langchain (异常)
[
  {"content": "You are a helpful assistant"},
  {"content": "Hello"}
]
```

---

## 问题 1: 消息 Role 字段缺失

### Root Cause

`langfuse-langchain@3.x` 的 `extractChatMessageContent` 方法使用 `instanceof` 检查消息类型：

```javascript
// langfuse-langchain 源码
extractChatMessageContent(message) {
  if (message instanceof messages.HumanMessage) {
    return { content: message.content, role: "user" };
  } else if (message instanceof messages.SystemMessage) {
    return { content: message.content, role: "system" };
  }
  // ...
  else if (!message.name) {
    return { content: message.content };  // ← 没有 role！
  }
}
```

**问题**：n8n 和 `langfuse-langchain` 使用不同版本的 `@langchain/core`，导致：
- n8n 创建的 `HumanMessage` 和 langfuse-langchain 引用的 `messages.HumanMessage` **不是同一个类**
- `instanceof` 检查返回 `false`
- 所有消息都走到 fallback 分支，丢失 `role` 字段

### 技术细节

```
n8n 使用的 @langchain/core@0.3.x
    └── HumanMessage (类 A)

langfuse-langchain 使用的 @langchain/core@0.2.x
    └── HumanMessage (类 B)

类 A !== 类 B，所以 instanceof 失败
```

### 解决方案

改用 `message.getType()` 方法判断类型，这是 LangChain BaseMessage 的标准方法，不受包版本影响：

```javascript
// 修复后
extractChatMessageContent(message) {
  const messageType = typeof message.getType === 'function' ? message.getType() : null;

  if (messageType === "human" || message instanceof messages.HumanMessage) {
    return { content: message.content, role: "user" };
  } else if (messageType === "system" || message instanceof messages.SystemMessage) {
    return { content: message.content, role: "system" };
  }
  // ...
}
```

---

## 问题 2: Prompt 关联失败

### Root Cause

`langfuse-langchain` 的 prompt 关联逻辑设计假设所有调用都通过 Chain 包装：

```
Chain 调用流程（设计预期）：
─────────────────────────────
handleChainStart(metadata)     ← 在这里注册 prompt 到 promptToParentRunMap
    ↓
handleChatModelStart
    ↓
handleGenerationStart          ← 从 promptToParentRunMap 获取已注册的 prompt
    ↓
关联成功 ✅


直接 ChatOpenAI 调用流程（n8n 实际情况）：
─────────────────────────────
handleChatModelStart(metadata) ← 直接进入，跳过了 handleChainStart
    ↓
handleGenerationStart          ← promptToParentRunMap 是空的，找不到 prompt
    ↓
关联失败 ❌
```

### 源码分析

```javascript
// handleChainStart 中注册 prompt（只在 Chain 调用时触发）
registerLangfusePrompt(parentRunId, metadata) {
  if (metadata && "langfusePrompt" in metadata && parentRunId) {
    this.promptToParentRunMap.set(parentRunId, metadata.langfusePrompt);
  }
}

// handleGenerationStart 中获取 prompt
handleGenerationStart(...) {
  const registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");
  // ↑ 直接调用 ChatOpenAI 时，这里永远是 undefined

  this.langfuse.generation({
    prompt: registeredPrompt,  // ← undefined，关联失败
    // ...
  });
}
```

### 解决方案

在 `handleGenerationStart` 中增加直接从 `metadata` 获取 `langfusePrompt` 的逻辑：

```javascript
// 修复后
handleGenerationStart(..., metadata) {
  let registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");

  // 新增：直接从 metadata 获取（支持直接 ChatOpenAI 调用）
  if (!registeredPrompt && metadata && "langfusePrompt" in metadata) {
    registeredPrompt = metadata.langfusePrompt;
  }

  this.langfuse.generation({
    prompt: registeredPrompt,  // ← 现在可以正确获取
    // ...
  });
}
```

---

## 为什么 Python SDK 没有这些问题

Python SDK 使用完全不同的方式集成 Langfuse：

| 特性 | Python SDK | Node.js + LangChain |
|------|-----------|---------------------|
| 消息格式 | 原生 JSON `{"role": "user", "content": "..."}` | 类实例 `HumanMessage` |
| 获取 role | 直接读取字段 | 需要类型转换 |
| 依赖关系 | 简单，直接包装 OpenAI | 复杂，多包多版本 |
| Langfuse 集成 | 直接包装 OpenAI 客户端 | 通过 LangChain Callback 机制 |

Python 示例：
```python
from langfuse.openai import openai

# 直接传递消息，role 字段天然存在
response = openai.chat.completions.create(
    messages=[
        {"role": "system", "content": "..."},  # ← 原生格式，role 明确
        {"role": "user", "content": "..."}
    ]
)
```

---

## 为什么不能升级到 @langfuse/langchain@4.x

Langfuse 在 2025 年 10 月发布了 `@langfuse/langchain@4.x`，修复了 `instanceof` 问题（改用 `getType()`）。

但是，v4.x **改变了认证方式**：

| 版本 | 认证方式 | 示例 |
|------|---------|------|
| `langfuse-langchain@3.x` | 构造函数参数 | `new CallbackHandler({ baseUrl, publicKey, secretKey })` |
| `@langfuse/langchain@4.x` | 环境变量 | `LANGFUSE_BASE_URL`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` |

**问题**：n8n 是多租户系统，不同用户可能使用不同的 Langfuse 账号。环境变量方式无法支持这种场景。

```javascript
// v3.x - 支持多租户（每个 credential 可以不同）
const handler = new CallbackHandler({
  baseUrl: credentials.langfuseBaseUrl,
  publicKey: credentials.langfusePublicKey,
  secretKey: credentials.langfuseSecretKey,
});

// v4.x - 不支持多租户（所有用户共享同一个账号）
// 只能通过环境变量配置
const handler = new CallbackHandler();
```

因此，我们继续使用 `langfuse-langchain@3.38.6` 并通过 patch 修复问题。

---

## 具体修复实现

修复涉及三个层面：**n8n-nodes-openai-langfuse 代码修改**、**langfuse-langchain patch**、**Docker 构建流程**。

### 1. n8n-nodes-openai-langfuse 修改

#### 1.1 新增 UI 配置项

**文件**: `nodes/LmChatOpenAiLangfuse/LmChatOpenAiLangfuse.node.ts`

在 Langfuse Metadata 中新增三个配置项：

```typescript
// 新增配置项
{
    displayName: 'Tags',
    name: 'tags',
    type: 'string',
    default: '',
    description: 'Comma-separated tags for trace filtering (e.g., "production,v1,test")',
},
{
    displayName: 'Prompt Name',
    name: 'promptName',
    type: 'string',
    default: '',
    description: 'Optional: Langfuse prompt name to link with this trace',
},
{
    displayName: 'Prompt Version',
    name: 'promptVersion',
    type: 'number',
    default: 0,
    description: 'Optional: Langfuse prompt version (0 means latest)',
},
```

#### 1.2 构造 langfusePrompt 对象

**文件**: `nodes/LmChatOpenAiLangfuse/LmChatOpenAiLangfuse.node.ts`

将用户配置的 Prompt Name/Version 转换为 `langfusePrompt` 对象，传入 ChatOpenAI 的 metadata：

```typescript
// 解析 tags
const tags: string[] = tagsRaw
    ? tagsRaw.split(',').map((t: string) => t.trim()).filter((t: string) => t.length > 0)
    : [];

// 构造 langfusePrompt 对象（关键！）
if (promptName) {
    customMetadata.langfusePrompt = {
        name: promptName,
        version: promptVersion && promptVersion > 0 ? promptVersion : 1,
        isFallback: false,
    };
}

// 创建 CallbackHandler
const lfHandler = new CallbackHandler({
    baseUrl: credentials.langfuseBaseUrl as string,
    publicKey: credentials.langfusePublicKey as string,
    secretKey: credentials.langfuseSecretKey as string,
    sessionId,
    userId,
    tags,  // 传入 tags
});

// 创建 ChatOpenAI，metadata 中包含 langfusePrompt
const model = new ChatOpenAI({
    callbacks: [lfHandler, new N8nLlmTracing(this)],
    metadata: customMetadata,  // ← langfusePrompt 在这里
    // ...
});
```

#### 1.3 N8nLlmTracing 增加 handleChatModelStart

**文件**: `nodes/LmChatOpenAiLangfuse/utils/N8nLlmTracing.ts`

原来只有 `handleLLMStart`（接收 `string[]`），新增 `handleChatModelStart`（接收 `BaseMessage[][]`）以正确提取 role：

```typescript
// 新增方法：从 BaseMessage 提取 role 和 content
private extractChatMessageContent(message: BaseMessage): { role: string; content: string | object } {
    const messageType = message.getType();
    let role: string;

    switch (messageType) {
        case "human":
            role = "user";
            break;
        case "ai":
            role = "assistant";
            break;
        case "system":
            role = "system";
            break;
        default:
            role = (message.name as string) || messageType || "unknown";
    }

    return { role, content: message.content as string | object };
}

// 新增方法：处理 Chat 模型
async handleChatModelStart(
    llm: Serialized,
    messages: BaseMessage[][],
    runId: string,
) {
    // 提取带 role 的消息
    const formattedMessages = messages.flatMap((messageGroup) =>
        messageGroup.map((m) => this.extractChatMessageContent(m))
    );

    // 存储到 runsMap
    this.runsMap[runId] = {
        index,
        options,
        messages: formattedMessages as any,
    };
}
```

### 2. langfuse-langchain Patch

**文件**: `patches/langfuse-langchain-fix.js`

这是一个 Node.js 脚本，在 Docker 构建时修改已安装的 `langfuse-langchain` 包。

#### 2.1 Patch 原理

```
Docker 构建流程：
─────────────────
1. npm install langfuse-langchain@3.38.6
   └── 安装到 node_modules/langfuse-langchain/lib/index.cjs.js

2. node patches/langfuse-langchain-fix.js
   └── 读取 index.cjs.js
   └── 字符串替换修复代码
   └── 写回 index.cjs.js

3. 运行时使用修复后的代码
```

#### 2.2 Patch 1: 修复 Role 提取

**修改位置**: `extractChatMessageContent` 方法

```javascript
// 原代码（使用 instanceof，跨包版本失败）
if (message instanceof messages.HumanMessage) {
  response = { content: message.content, role: "user" };
}

// Patch 后（使用 getType() + instanceof 双重检查）
const messageType = typeof message.getType === 'function' ? message.getType() : null;
if (messageType === "human" || message instanceof messages.HumanMessage) {
  response = { content: message.content, role: "user" };
}
```

**Fallback 增强**：当 `getType()` 也失败时，使用 constructor name：

```javascript
} else if (!message.name) {
  // 原代码：直接返回无 role
  // response = { content: message.content };

  // Patch 后：尝试从 constructor name 获取
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
}
```

#### 2.3 Patch 2: 修复 Prompt 关联

**修改位置**: `handleGenerationStart` 方法

```javascript
// 原代码（只从 map 获取，直接调用时 map 为空）
const registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");

// Patch 后（增加从 metadata 直接获取）
let registeredPrompt = this.promptToParentRunMap.get(parentRunId ?? "root");
// 新增：支持直接 ChatOpenAI 调用
if (!registeredPrompt && metadata && "langfusePrompt" in metadata) {
  registeredPrompt = metadata.langfusePrompt;
}
```

### 3. Docker 构建流程

**文件**: `Dockerfile`

```dockerfile
# 1. 复制源码并编译
COPY n8n-nodes-openai-langfuse /tmp/n8n-nodes-openai-langfuse
RUN cd /tmp/n8n-nodes-openai-langfuse && \
    npm install --include=dev && \
    npm run build && \
    npm pack

# 2. 安装到自定义节点目录
RUN mkdir -p /opt/n8n-custom-nodes && \
    cd /opt/n8n-custom-nodes && \
    npm init -y && \
    npm install /tmp/n8n-nodes-openai-langfuse-*.tgz --save

# 3. 应用 Patch（关键步骤）
COPY n8n-nodes-openai-langfuse/patches/langfuse-langchain-fix.js /tmp/langfuse-langchain-fix.js
RUN node /tmp/langfuse-langchain-fix.js /opt/n8n-custom-nodes/node_modules/langfuse-langchain/lib

# 4. 设置环境变量让 n8n 加载自定义节点
ENV N8N_CUSTOM_EXTENSIONS="/opt/n8n-custom-nodes"
```

### 4. 数据流总结

```
用户在 n8n 配置:
  Prompt Name: "根据热点选品"
  Prompt Version: 11
      ↓
LmChatOpenAiLangfuse.node.ts:
  构造 metadata.langfusePrompt = { name: "根据热点选品", version: 11, isFallback: false }
      ↓
ChatOpenAI({ metadata, callbacks: [lfHandler] }):
  调用时触发 callbacks
      ↓
langfuse-langchain CallbackHandler:
  handleChatModelStart(messages, metadata)
      ↓
  handleGenerationStart(metadata)
      ↓
  [Patch 生效] 从 metadata.langfusePrompt 获取 prompt
      ↓
  langfuse.generation({ prompt: { name: "根据热点选品", version: 11 } })
      ↓
Langfuse 服务端:
  关联 trace 到指定 prompt
```

### 5. 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `nodes/.../LmChatOpenAiLangfuse.node.ts` | 修改 | 新增 Tags/Prompt 配置项，构造 langfusePrompt |
| `nodes/.../utils/N8nLlmTracing.ts` | 修改 | 新增 handleChatModelStart 方法 |
| `patches/langfuse-langchain-fix.js` | 新增 | Patch 脚本 |
| `package.json` | 修改 | 锁定 langfuse-langchain@^3.38.6 |
| `Dockerfile` | 修改 | 添加 patch 步骤 |

---

## 长期维护建议

### 短期（当前方案）

- 锁定 `langfuse-langchain@^3.38.6` 版本
- 使用 patch 脚本在构建时修复

### 中期

- 向上游 `langfuse-js` 仓库提交 PR，修复 prompt 关联问题
- PR 地址：https://github.com/langfuse/langfuse-js
- 已准备的修复分支：https://github.com/androidfans/langfuse-js/tree/fix/n8n-compat

### 如果上游接受 PR

1. 等待新版本发布（可能是 v3.39.x 或 v4.x 支持构造函数认证）
2. 更新 `package.json` 中的版本
3. 删除 `patches/` 目录
4. 删除 Dockerfile 中的 patch 步骤

### 如果上游不接受 PR

- 继续使用 patch 方案
- 当 `langfuse-langchain` 有新版本时，检查 patch 是否需要更新
- 或者 fork 维护自己的版本

---

## 相关链接

- [langfuse-js 仓库](https://github.com/langfuse/langfuse-js)
- [修复 instanceof 问题的 PR](https://github.com/langfuse/langfuse-js/pull/680)
- [我们的 fork](https://github.com/androidfans/langfuse-js/tree/fix/n8n-compat)
- [n8n-nodes-openai-langfuse](https://github.com/androidfans/n8n-nodes-openai-langfuse)

---

## 附录：n8n AI 节点架构

### 为什么我们的节点会受到 n8n 调用方式的影响？

n8n 的 AI 功能不是让你"实现一个 model"，而是**提供一个 LangChain 模型实例给其他节点使用**。

### 工作流结构

```
┌─────────────────────┐
│  AI Agent 节点       │   ← 消费者：需要一个 LLM 来执行任务
│  (或 Chain 节点)     │
└─────────┬───────────┘
          │ 需要 LLM
          ▼
┌─────────────────────┐
│  LmChatOpenAiLangfuse │   ← 提供者：我们的节点
│  (Language Model)    │      输出类型: ai_languageModel
└─────────────────────┘
```

### 我们的节点做了什么

`LmChatOpenAiLangfuse` 节点的 `supplyData` 方法返回一个 **LangChain ChatOpenAI 实例**：

```typescript
async supplyData(this: ISupplyDataFunctions, itemIndex: number): Promise<SupplyData> {
    // 1. 获取凭证
    const credentials = await this.getCredentials('openAiApiWithLangfuseApi');

    // 2. 创建 Langfuse CallbackHandler
    const lfHandler = new CallbackHandler({
        baseUrl: credentials.langfuseBaseUrl,
        publicKey: credentials.langfusePublicKey,
        secretKey: credentials.langfuseSecretKey,
    });

    // 3. 创建 LangChain ChatOpenAI 实例，附带 callback
    const model = new ChatOpenAI({
        callbacks: [lfHandler],  // ← Langfuse 通过 callback 监听
        apiKey: credentials.apiKey,
        model: modelName,
    });

    // 4. 返回给 n8n
    return {
        response: model,  // ← 其他节点会拿到这个 model
    };
}
```

### 谁在调用这个 model？

**不是我们调用，是 n8n 的 AI Agent/Chain 节点调用**：

```typescript
// AI Agent 节点内部：

// 1. 从连接的 Language Model 节点获取 model
const model = await this.getInputConnectionData('ai_languageModel');

// 2. 直接调用 model（不经过 Chain）
const result = await model.invoke(messages);
//                         ↑
//            这会触发 LangChain 的 callback 机制
//            但因为没有 Chain 包装，不会触发 handleChainStart
```

### 为什么会受影响

```
LangChain Callback 触发顺序：
─────────────────────────────

通过 Chain 调用（langfuse-langchain 设计预期）：
  chain.invoke()
      → handleChainStart(metadata)     ← 注册 prompt
      → handleChatModelStart(messages)
      → handleGenerationStart          ← 从 map 获取 prompt ✅

直接调用 model（n8n 实际做法）：
  model.invoke()
      → handleChatModelStart(messages)  ← 跳过了 Chain！
      → handleGenerationStart           ← map 是空的 ❌
```

**本质**：n8n 的 AI Agent 节点**直接使用 LangChain model**，不套 Chain 包装。而 `langfuse-langchain` 假设所有调用都通过 Chain。

### 角色总结

| 组件 | 角色 | 说明 |
|------|------|------|
| LmChatOpenAiLangfuse | 提供者 | 不处理请求，只**提供** ChatOpenAI 实例 |
| AI Agent 节点 | 消费者 | **消费**我们提供的 model，直接调用 `model.invoke()` |
| langfuse-langchain | 监听者 | 通过 LangChain callback 机制监听调用 |
| 问题根源 | - | n8n 直接调用 model，跳过 Chain，导致 callback 触发顺序不符合 langfuse 预期 |
