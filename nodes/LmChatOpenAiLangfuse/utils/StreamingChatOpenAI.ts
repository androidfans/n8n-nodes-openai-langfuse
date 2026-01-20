import { ChatOpenAI } from '@langchain/openai';
import type { BaseMessage, AIMessageChunk } from '@langchain/core/messages';
import { AIMessage } from '@langchain/core/messages';
import type { ChatResult } from '@langchain/core/outputs';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import { concat } from '@langchain/core/utils/stream';

/**
 * StreamingChatOpenAI - 使用流式请求防止网关超时的 ChatOpenAI 包装器
 *
 * 问题背景：
 * 一些模型（如 o1, Claude 等）在思考时可能需要很长时间才返回第一个 token，
 * 这会导致 HTTP 连接在网关层（nginx、cloudflare 等）超时。
 *
 * 解决方案：
 * 1. 内部始终使用 stream 模式请求 API
 * 2. 流式接收数据保持连接活跃
 * 3. 累积所有 chunks 后返回完整响应给上层
 *
 * 对于调用方（n8n AI Agent）来说，行为与普通 invoke 完全一致。
 */
export class StreamingChatOpenAI extends ChatOpenAI {

    async _generate(
        messages: BaseMessage[],
        options: this['ParsedCallOptions'],
        runManager?: CallbackManagerForLLMRun
    ): Promise<ChatResult> {
        // 强制使用流式模式
        const streamOptions = {
            ...options,
            stream: true,
        };

        try {
            // 使用流式请求
            const stream = await this._streamResponseChunks(
                messages,
                streamOptions,
                runManager
            );

            // 累积所有 chunks
            let accumulated: AIMessageChunk | undefined;
            for await (const chunk of stream) {
                if (!accumulated) {
                    accumulated = chunk.message as AIMessageChunk;
                } else {
                    accumulated = concat(accumulated, chunk.message as AIMessageChunk);
                }
            }

            if (!accumulated) {
                throw new Error('No response received from model');
            }

            // 转换为 ChatResult 格式
            const result: ChatResult = {
                generations: [
                    {
                        text: typeof accumulated.content === 'string'
                            ? accumulated.content
                            : JSON.stringify(accumulated.content),
                        message: new AIMessage({
                            content: accumulated.content,
                            additional_kwargs: accumulated.additional_kwargs,
                            response_metadata: accumulated.response_metadata,
                            tool_calls: accumulated.tool_calls,
                            usage_metadata: accumulated.usage_metadata,
                        }),
                        generationInfo: accumulated.response_metadata,
                    },
                ],
                llmOutput: accumulated.response_metadata,
            };

            return result;
        } catch (error) {
            // 如果流式失败，回退到普通请求
            console.warn('[StreamingChatOpenAI] Stream failed, falling back to normal request:', error);
            return super._generate(messages, options, runManager);
        }
    }
}
