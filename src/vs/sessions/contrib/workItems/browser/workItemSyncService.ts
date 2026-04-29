/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IProgress, IProgressStep } from '../../../../platform/progress/common/progress.js';
import { IWorkItem } from '../../../services/workItems/common/workItem.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { IChatService } from '../../../../workbench/contrib/chat/common/chatService/chatService.js';
import { ChatAgentLocation } from '../../../../workbench/contrib/chat/common/constants.js';
import { ChatMessageRole, IChatMessage, ILanguageModelsService, getTextResponseFromStream } from '../../../../workbench/contrib/chat/common/languageModels.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';

const LOG_PREFIX = '[WorkItemSyncService]';

/**
 * Maximum number of characters of raw conversation to include per session
 * when sending to the LLM for extraction. Modern LLMs handle large contexts
 * well, so we use a generous limit.
 */
const MAX_RAW_CHARS_PER_SESSION = 80000;

/** Maximum number of exchanges to include per session (most recent). */
const MAX_EXCHANGES_PER_SESSION = 120;

export const IWorkItemSyncService = createDecorator<IWorkItemSyncService>('workItemSyncService');

export interface IWorkItemSyncService {
	readonly _serviceBrand: undefined;

	/**
	 * Generate a comprehensive, structured summary of a work item's sessions
	 * using a two-phase Map-Reduce LLM approach:
	 *
	 * Phase 1 (Map): Extract structured insights from each session individually.
	 * Phase 2 (Reduce): Synthesize all session insights into a final summary.
	 *
	 * The result covers: background, problem, proposals, trade-offs, decisions,
	 * implementation, verification, and follow-ups.
	 */
	generateSessionSummary(workItem: IWorkItem, token: CancellationToken, options?: IGenerateSessionSummaryOptions): Promise<string>;
}

export interface IGenerateSessionSummaryOptions {
	/** Optional progress reporter for per-session feedback. */
	readonly progress?: IProgress<IProgressStep>;
}

export class WorkItemSyncService implements IWorkItemSyncService {

	declare readonly _serviceBrand: undefined;

	constructor(
		@IChatService private readonly _chatService: IChatService,
		@ILanguageModelsService private readonly _languageModelsService: ILanguageModelsService,
		@ILogService private readonly _logService: ILogService,
	) { }

	async generateSessionSummary(workItem: IWorkItem, token: CancellationToken, options?: IGenerateSessionSummaryOptions): Promise<string> {
		const sessions = workItem.sessions.get();
		const progress = options?.progress;

		if (sessions.length === 0) {
			return localize('sync.noSessions', "No agent sessions associated with this work item.");
		}

		const modelId = await this._findSuitableModel();
		if (!modelId) {
			this._logService.warn(LOG_PREFIX, 'No language model available for summarization');
			return this._buildFallbackSummary(sessions);
		}

		// Collect raw conversation content from all sessions
		progress?.report({ message: localize('sync.collecting', "Collecting session data...") });
		const sessionData = await this._collectSessionData(sessions, token);
		const sessionsWithContent = sessionData.filter(s => s.exchanges.length > 0);
		this._logService.info(LOG_PREFIX, `Collected conversation from ${sessionsWithContent.length}/${sessionData.length} sessions`);

		if (sessionsWithContent.length === 0) {
			this._logService.warn(LOG_PREFIX, 'No conversation content found in any session');
			return this._buildFallbackSummary(sessions);
		}

		// Phase 1 (Map): Extract structured insights per session
		const sessionInsights = await this._phaseExtract(modelId, sessionData, progress, token);
		this._logService.info(LOG_PREFIX, `Phase 1 complete: extracted insights from ${sessionInsights.length} sessions`);

		if (token.isCancellationRequested) {
			return localize('sync.cancelled', "Summary generation was cancelled.");
		}

		// Phase 2 (Reduce): Synthesize all insights into final summary
		progress?.report({ message: localize('sync.synthesizing', "Synthesizing final summary...") });
		const finalSummary = await this._phaseSynthesize(modelId, workItem, sessionInsights, token);
		if (finalSummary) {
			return this._appendSignature(finalSummary, sessions.length);
		}

		// If synthesis fails, concatenate phase 1 outputs
		this._logService.warn(LOG_PREFIX, 'Phase 2 synthesis failed, returning concatenated session insights');
		return this._appendSignature(this._concatenateInsights(workItem, sessionInsights), sessions.length);
	}

	// #region Phase 1: Per-session extraction (Map)

	private async _phaseExtract(
		modelId: string,
		sessionData: ISessionData[],
		progress: IProgress<IProgressStep> | undefined,
		token: CancellationToken,
	): Promise<ISessionInsight[]> {
		const insights: ISessionInsight[] = [];
		const total = sessionData.length;

		for (let i = 0; i < sessionData.length; i++) {
			const data = sessionData[i];

			if (token.isCancellationRequested) {
				break;
			}

			progress?.report({
				message: localize('sync.analyzingSession', "Analyzing session {0}/{1}: {2}", i + 1, total, data.title),
				increment: Math.round(100 / (total + 1)), // +1 reserves room for the synthesis step
			});

			if (data.exchanges.length === 0) {
				this._logService.warn(LOG_PREFIX, `Session "${data.title}" has 0 conversation exchanges — content may not have loaded`);
				// No conversation — produce a minimal insight from metadata
				insights.push({
					sessionTitle: data.title,
					status: formatSessionStatus(data.status),
					raw: localize('sync.noConversation', "(No conversation content available)"),
					fileChanges: data.fileChanges,
				});
				continue;
			}

			const insight = await this._extractSessionInsight(modelId, data, token);
			insights.push(insight);
		}

		return insights;
	}

	private async _extractSessionInsight(
		modelId: string,
		data: ISessionData,
		token: CancellationToken,
	): Promise<ISessionInsight> {
		const systemPrompt = [
			'You are a technical analyst extracting structured information from a conversation between a user and an AI coding agent.',
			'Analyze the FULL conversation carefully. Only include sections that are clearly present — omit any that are not applicable.',
			'',
			'Output the following sections using exactly these markdown headers:',
			'',
			'## Background',
			'Why this work was initiated. The broader context or motivation.',
			'',
			'## Problem Statement',
			'The specific problem or task being addressed. Include error messages, symptoms, or requirements verbatim when present.',
			'',
			'## Proposals & Approaches',
			'What solutions or approaches were explored. List each approach distinctly with:',
			'- What was proposed',
			'- Key technical details (APIs, patterns, libraries)',
			'- Why it was considered or rejected',
			'',
			'## Trade-offs',
			'Advantages and disadvantages of different approaches discussed.',
			'If the user or agent explicitly compared options, present the comparison.',
			'',
			'## Decisions',
			'What was ultimately decided, and why. If the user explicitly stated a preference or made a decision, quote the relevant text.',
			'',
			'## Implementation',
			'What was actually built or changed. Include:',
			'- Specific file paths and names',
			'- Function/class/interface names',
			'- API changes or new APIs introduced',
			'- Architecture patterns used',
			'- Configuration changes',
			'',
			'## Verification',
			'How the work was or should be verified/tested. Include specific test commands, test file names, or acceptance criteria.',
			'',
			'## Issues Encountered',
			'Problems, errors, or blockers hit during the session. Include error messages and how they were resolved.',
			'',
			'## Open Questions & Follow-ups',
			'Remaining uncertainties, deferred work, known limitations, or suggested next steps.',
			'',
			'Rules:',
			'- Be specific and technical. Include file names, function names, class names, error messages when mentioned.',
			'- Use bullet points within each section for readability.',
			'- If a section has no relevant content from the conversation, omit it entirely.',
			'- Do NOT add information that is not present in the conversation.',
			'- When the user or agent states something important, quote it directly with > blockquote.',
			'- Target 200-500 words total. Be concise but complete.',
		].join('\n');

		const userPrompt = this._buildConversationPrompt(data);

		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: userPrompt }] },
		];

		try {
			const response = await this._languageModelsService.sendChatRequest(
				modelId,
				undefined,
				messages,
				{},
				token,
			);
			const text = await getTextResponseFromStream(response);
			if (!text) {
				this._logService.warn(LOG_PREFIX, `Phase 1 extraction for session "${data.title}": LLM returned empty text`);
			} else {
				this._logService.info(LOG_PREFIX, `Phase 1 extraction for session "${data.title}": got ${text.length} chars`);
			}
			return {
				sessionTitle: data.title,
				status: formatSessionStatus(data.status),
				raw: text || this._buildConversationSnippet(data),
				fileChanges: data.fileChanges,
			};
		} catch (e) {
			this._logService.warn(LOG_PREFIX, `Phase 1 extraction failed for session "${data.title}":`, e);
			// Return raw conversation snippet as fallback
			return {
				sessionTitle: data.title,
				status: formatSessionStatus(data.status),
				raw: this._buildConversationSnippet(data),
				fileChanges: data.fileChanges,
			};
		}
	}

	// #endregion

	// #region Phase 2: Cross-session synthesis (Reduce)

	private async _phaseSynthesize(
		modelId: string,
		workItem: IWorkItem,
		insights: ISessionInsight[],
		token: CancellationToken,
	): Promise<string | undefined> {
		const title = workItem.title.get();
		const description = workItem.description.get();

		const systemPrompt = [
			'You are a senior technical writer producing a comprehensive work item summary from multiple agent session analyses.',
			'',
			'Produce a single, well-organized document that synthesizes all session insights into a coherent narrative.',
			'Use the following structure (include all sections that have content; omit those that don\'t):',
			'',
			'## Summary',
			'One-paragraph executive summary of the overall work item progress. What was the goal and what was accomplished.',
			'',
			'## Background & Motivation',
			'Why this work exists. The broader context. What triggered it (bug report, feature request, tech debt, etc.).',
			'',
			'## Problem Statement',
			'The specific problem(s) being solved. Include error messages, symptoms, or requirements if known.',
			'',
			'## Approaches Explored',
			'All proposals and approaches that were considered across sessions. For each approach:',
			'- What it entailed',
			'- Why it was considered',
			'- Whether it was adopted or rejected (and why)',
			'',
			'## Trade-offs & Comparisons',
			'Key trade-offs between approaches. Present as a structured comparison when multiple options exist.',
			'Include performance, complexity, maintainability, and correctness considerations.',
			'',
			'## Decisions Made',
			'Final decisions and their rationale. Quote the user\'s stated preferences when available.',
			'',
			'## Implementation Details',
			'What was built. Include specific technical details:',
			'- Files changed or created (with paths)',
			'- APIs used or introduced',
			'- Architecture patterns employed',
			'- Configuration or infrastructure changes',
			'- Key code patterns or snippets worth noting',
			'',
			'## How to Verify',
			'Steps to verify or test the work. Include:',
			'- Commands to run',
			'- Test cases or scenarios',
			'- Acceptance criteria',
			'- Known edge cases',
			'',
			'## Issues Encountered',
			'Problems hit during implementation. Include error messages and how they were resolved.',
			'This helps future developers understand potential pitfalls.',
			'',
			'## Open Questions & Follow-ups',
			'Remaining work, unresolved questions, potential improvements, known limitations, or risks.',
			'Categorize as: TODO, QUESTION, RISK, or IMPROVEMENT.',
			'',
			'Rules:',
			'- Synthesize across sessions — do NOT repeat per-session. Merge related information.',
			'- When sessions show iterative refinement, describe the evolution clearly.',
			'- Be specific: include file names, function names, error messages, command lines.',
			'- Use bullet points and sub-bullets for readability.',
			'- When information from different sessions conflicts, note the conflict and which session is more recent.',
			'- Write in third person, past tense for completed work, present for ongoing.',
			'- No meta-commentary, greetings, or sign-offs.',
			'- Target 400-1000 words depending on complexity.',
		].join('\n');

		const sections: string[] = [];
		sections.push(`# Work Item: "${title}"`);
		if (description) {
			sections.push(`\nOriginal description: ${description}`);
		}
		sections.push(`\nTotal sessions: ${insights.length}`);
		sections.push('\n---\n');
		sections.push('Below are the structured insights extracted from each session:\n');

		for (let i = 0; i < insights.length; i++) {
			const insight = insights[i];
			sections.push(`# Session ${i + 1}: "${insight.sessionTitle}" [${insight.status}]`);
			if (insight.fileChanges.length > 0) {
				const files = insight.fileChanges.map(f => `${f.fileName} (+${f.insertions} -${f.deletions})`);
				sections.push(`Files changed: ${files.join(', ')}`);
			}
			sections.push('');
			sections.push(insight.raw);
			sections.push('\n---\n');
		}

		sections.push('Please synthesize the above into a single comprehensive work item summary following the specified structure.');

		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: sections.join('\n') }] },
		];

		try {
			const response = await this._languageModelsService.sendChatRequest(
				modelId,
				undefined,
				messages,
				{},
				token,
			);
			const text = await getTextResponseFromStream(response);
			if (!text) {
				this._logService.warn(LOG_PREFIX, 'Phase 2 synthesis: LLM returned empty text');
				return undefined;
			}
			return text;
		} catch (e) {
			this._logService.warn(LOG_PREFIX, 'Phase 2 synthesis error:', e);
			return undefined;
		}
	}

	// #endregion

	// #region Conversation loading

	private async _collectSessionData(sessions: readonly ISession[], token: CancellationToken): Promise<ISessionData[]> {
		const results: ISessionData[] = [];

		for (const session of sessions) {
			const exchanges = await this._extractConversation(session, token);

			const changes = session.changes.get();
			const fileChanges = changes.map(c => {
				const uri = isIChatSessionFileChange2(c) ? (c.modifiedUri ?? c.uri) : c.modifiedUri;
				return {
					fileName: basename(uri),
					insertions: c.insertions,
					deletions: c.deletions,
				};
			});

			results.push({
				title: session.title.get(),
				status: session.status.get(),
				updatedAt: session.updatedAt.get(),
				exchanges,
				fileChanges,
			});
		}

		return results;
	}

	private async _extractConversation(session: ISession, token: CancellationToken): Promise<IConversationExchange[]> {
		const sessionTitle = session.title.get();

		// Strategy 1: Try the session resource directly (already loaded in widget)
		const directModel = this._chatService.getSession(session.resource);
		if (directModel) {
			const requests = directModel.getRequests();
			this._logService.info(LOG_PREFIX, `[Strategy 1] Session "${sessionTitle}": found loaded model with ${requests.length} requests`);
			const exchanges = this._extractFromChatModel(directModel);
			if (exchanges.length > 0) {
				return exchanges;
			}
			this._logService.info(LOG_PREFIX, `[Strategy 1] Session "${sessionTitle}": model found but extracted 0 exchanges (requests may have empty responses)`);
		} else {
			this._logService.info(LOG_PREFIX, `[Strategy 1] Session "${sessionTitle}": no loaded model for resource ${session.resource.toString()}`);
		}

		// Strategy 2: Try main chat resource
		const mainChat = session.mainChat;
		const mainChatModel = this._chatService.getSession(mainChat.resource);
		if (mainChatModel) {
			const requests = mainChatModel.getRequests();
			this._logService.info(LOG_PREFIX, `[Strategy 2] Session "${sessionTitle}": found main chat model with ${requests.length} requests`);
			const exchanges = this._extractFromChatModel(mainChatModel);
			if (exchanges.length > 0) {
				return exchanges;
			}
			this._logService.info(LOG_PREFIX, `[Strategy 2] Session "${sessionTitle}": main chat model found but extracted 0 exchanges`);
		} else {
			this._logService.info(LOG_PREFIX, `[Strategy 2] Session "${sessionTitle}": no loaded model for main chat ${mainChat.resource.toString()}`);
		}

		// Strategy 3: Try each chat in the session (multi-chat sessions)
		const chats = session.chats.get();
		this._logService.info(LOG_PREFIX, `[Strategy 3] Session "${sessionTitle}": checking ${chats.length} chats`);
		for (const chat of chats) {
			const chatModel = this._chatService.getSession(chat.resource);
			if (chatModel) {
				const requests = chatModel.getRequests();
				this._logService.info(LOG_PREFIX, `[Strategy 3] Session "${sessionTitle}": chat "${chat.title.get()}" has ${requests.length} requests`);
				const exchanges = this._extractFromChatModel(chatModel);
				if (exchanges.length > 0) {
					return exchanges;
				}
			}
		}

		// Strategy 4: Load from persistence using main chat resource
		try {
			this._logService.info(LOG_PREFIX, `[Strategy 4] Session "${sessionTitle}": loading main chat from persistence: ${mainChat.resource.toString()}`);
			const modelRef = await this._chatService.acquireOrLoadSession(mainChat.resource, ChatAgentLocation.Chat, token);
			if (modelRef) {
				try {
					const requests = modelRef.object.getRequests();
					this._logService.info(LOG_PREFIX, `[Strategy 4] Session "${sessionTitle}": loaded model with ${requests.length} requests`);
					const exchanges = this._extractFromChatModel(modelRef.object);
					if (exchanges.length > 0) {
						return exchanges;
					}
					this._logService.info(LOG_PREFIX, `[Strategy 4] Session "${sessionTitle}": loaded but extracted 0 exchanges`);
				} finally {
					modelRef.dispose();
				}
			} else {
				this._logService.info(LOG_PREFIX, `[Strategy 4] Session "${sessionTitle}": acquireOrLoadSession returned undefined for main chat`);
			}
		} catch (e) {
			this._logService.warn(LOG_PREFIX, `[Strategy 4] Session "${sessionTitle}": failed to load main chat: ${e}`);
		}

		// Strategy 5: Load session resource from persistence
		try {
			this._logService.info(LOG_PREFIX, `[Strategy 5] Session "${sessionTitle}": loading session resource from persistence: ${session.resource.toString()}`);
			const modelRef = await this._chatService.acquireOrLoadSession(session.resource, ChatAgentLocation.Chat, token);
			if (modelRef) {
				try {
					const requests = modelRef.object.getRequests();
					this._logService.info(LOG_PREFIX, `[Strategy 5] Session "${sessionTitle}": loaded model with ${requests.length} requests`);
					const exchanges = this._extractFromChatModel(modelRef.object);
					if (exchanges.length > 0) {
						return exchanges;
					}
				} finally {
					modelRef.dispose();
				}
			} else {
				this._logService.info(LOG_PREFIX, `[Strategy 5] Session "${sessionTitle}": acquireOrLoadSession returned undefined`);
			}
		} catch (e) {
			this._logService.warn(LOG_PREFIX, `[Strategy 5] Session "${sessionTitle}": failed: ${e}`);
		}

		// Strategy 6: Load each individual chat from persistence
		for (const chat of chats) {
			try {
				const modelRef = await this._chatService.acquireOrLoadSession(chat.resource, ChatAgentLocation.Chat, token);
				if (modelRef) {
					try {
						const requests = modelRef.object.getRequests();
						this._logService.info(LOG_PREFIX, `[Strategy 6] Session "${sessionTitle}": chat "${chat.title.get()}" loaded with ${requests.length} requests`);
						const exchanges = this._extractFromChatModel(modelRef.object);
						if (exchanges.length > 0) {
							return exchanges;
						}
					} finally {
						modelRef.dispose();
					}
				}
			} catch {
				// Continue to next chat
			}
		}

		this._logService.warn(LOG_PREFIX, `No conversation content found for session "${sessionTitle}" after trying all 6 loading strategies`);
		return [];
	}

	private _extractFromChatModel(chatModel: { getRequests(): { message: { text: string }; response?: { response: { toString(): string; getMarkdown(): string } } }[] }): IConversationExchange[] {
		const exchanges: IConversationExchange[] = [];
		const requests = chatModel.getRequests();
		let totalChars = 0;

		for (const request of requests.slice(-MAX_EXCHANGES_PER_SESSION)) {
			const userMessage = request.message.text;
			// Use toString() instead of getMarkdown() to include tool invocation
			// summaries, which form the bulk of agent session content
			const rawResponse = request.response?.response.toString() ?? '';
			const agentResponse = this._cleanAgentResponse(rawResponse);

			const exchangeChars = userMessage.length + agentResponse.length;
			if (totalChars + exchangeChars > MAX_RAW_CHARS_PER_SESSION) {
				const remaining = MAX_RAW_CHARS_PER_SESSION - totalChars;
				if (remaining > 200) {
					exchanges.push({
						userMessage: userMessage.slice(0, Math.min(userMessage.length, remaining / 2)),
						agentResponse: agentResponse.slice(0, Math.min(agentResponse.length, remaining / 2)),
					});
				}
				break;
			}

			exchanges.push({ userMessage, agentResponse });
			totalChars += exchangeChars;
		}

		return exchanges;
	}

	/**
	 * Strip verbose tool invocation artifacts from agent responses to reduce
	 * token usage while keeping the agent's explanatory text and decisions.
	 */
	private _cleanAgentResponse(text: string): string {
		let cleaned = text;
		// Remove repetitive file-content blocks (``` fenced blocks over 40 lines)
		cleaned = cleaned.replace(/```[\s\S]{0,30}\n([\s\S]{2000,}?)```/g, (match, content: string) => {
			const lineCount = content.split('\n').length;
			if (lineCount > 40) {
				const firstLines = content.split('\n').slice(0, 5).join('\n');
				return '```\n' + firstLines + '\n... (' + lineCount + ' lines omitted)\n```';
			}
			return match;
		});
		// Collapse repeated whitespace
		cleaned = cleaned.replace(/\n{4,}/g, '\n\n\n');
		return cleaned;
	}

	// #endregion

	// #region Prompt builders

	private _buildConversationPrompt(data: ISessionData): string {
		const sections: string[] = [];
		sections.push(`Session: "${data.title}" [${formatSessionStatus(data.status)}]`);
		sections.push(`Last updated: ${data.updatedAt.toLocaleString()}`);

		if (data.fileChanges.length > 0) {
			const files = data.fileChanges.map(f => `${f.fileName} (+${f.insertions} -${f.deletions})`);
			sections.push(`Files changed: ${files.join(', ')}`);
		}

		sections.push('\n--- Conversation ---\n');

		for (const exchange of data.exchanges) {
			sections.push(`**User:** ${exchange.userMessage}`);
			if (exchange.agentResponse) {
				sections.push(`**Agent:** ${exchange.agentResponse}`);
			}
			sections.push('');
		}

		return sections.join('\n');
	}

	private _buildConversationSnippet(data: ISessionData): string {
		// Fallback: just show user messages as bullet points
		const bullets = data.exchanges.slice(0, 10).map(e => {
			const firstLine = e.userMessage.split('\n')[0].trim();
			return `- ${firstLine.length > 150 ? firstLine.slice(0, 150) + '...' : firstLine}`;
		});
		return bullets.join('\n');
	}

	// #endregion

	// #region Utilities

	private async _findSuitableModel(): Promise<string | undefined> {
		// Use selectLanguageModels to ensure models are resolved, and prefer
		// the 'copilot' vendor which supports direct sendChatRequest from core.
		// Models from other vendors (e.g. copilotcli) may not stream text parts.
		const copilotModels = await this._languageModelsService.selectLanguageModels({ vendor: 'copilot' });
		this._logService.trace(LOG_PREFIX, `Available copilot models: ${copilotModels.length}`);

		// Prefer a model with a large context window for summarization
		let bestId: string | undefined;
		let bestMaxInput = 0;

		for (const id of copilotModels) {
			const metadata = this._languageModelsService.lookupLanguageModel(id);
			if (metadata && metadata.isUserSelectable !== false) {
				this._logService.trace(LOG_PREFIX, `  Model: ${id} (family: ${metadata.family}, maxInput: ${metadata.maxInputTokens})`);
				if (metadata.maxInputTokens > bestMaxInput) {
					bestMaxInput = metadata.maxInputTokens;
					bestId = id;
				}
			}
		}

		if (bestId) {
			this._logService.trace(LOG_PREFIX, `Selected model: ${bestId} (maxInput: ${bestMaxInput})`);
			return bestId;
		}

		// Fallback: try any copilot model
		if (copilotModels.length > 0) {
			this._logService.trace(LOG_PREFIX, `Falling back to first copilot model: ${copilotModels[0]}`);
			return copilotModels[0];
		}

		this._logService.warn(LOG_PREFIX, 'No copilot vendor models available');
		return undefined;
	}

	private _concatenateInsights(workItem: IWorkItem, insights: ISessionInsight[]): string {
		const lines: string[] = [];
		lines.push(`## ${workItem.title.get()}`);
		lines.push('');

		for (const insight of insights) {
			lines.push(`### ${insight.sessionTitle} [${insight.status}]`);
			if (insight.fileChanges.length > 0) {
				const total = insight.fileChanges.reduce((s, c) => s + c.insertions + c.deletions, 0);
				lines.push(`_${insight.fileChanges.length} files changed, ${total} lines affected_`);
				lines.push('');
			}
			lines.push(insight.raw);
			lines.push('');
		}

		return lines.join('\n');
	}

	private _appendSignature(summary: string, sessionCount: number): string {
		const timestamp = new Date().toLocaleString();
		return [
			summary,
			'',
			'---',
			`*✨ Synthesized by Agent App from ${sessionCount} session${sessionCount === 1 ? '' : 's'} · ${timestamp}*`,
		].join('\n');
	}

	private _buildFallbackSummary(sessions: readonly ISession[]): string {
		const lines: string[] = [];
		lines.push(`## ${localize('sync.progressUpdate', "Progress Update")}`);
		lines.push('');
		lines.push(localize('sync.noLLM', "No language model available. Showing session metadata only."));
		lines.push('');

		for (const session of sessions) {
			const title = session.title.get() || localize('sync.untitledSession', "Untitled Session");
			const status = formatSessionStatus(session.status.get());
			lines.push(`### ${title}`);
			lines.push(`**${localize('sync.statusLabel', "Status")}:** ${status}`);
			lines.push(`**${localize('sync.updatedAt', "Last Updated")}:** ${session.updatedAt.get().toLocaleString()}`);

			const changes = session.changes.get();
			if (changes.length > 0) {
				const totalIns = changes.reduce((s, c) => s + c.insertions, 0);
				const totalDel = changes.reduce((s, c) => s + c.deletions, 0);
				lines.push(localize('sync.filesSummary', "Changed {0} files (+{1} -{2}):", changes.length, totalIns, totalDel));
				for (const c of changes.slice(0, 10)) {
					const uri = isIChatSessionFileChange2(c) ? (c.modifiedUri ?? c.uri) : c.modifiedUri;
					lines.push(`- \`${basename(uri)}\` (+${c.insertions} -${c.deletions})`);
				}
			}
			lines.push('');
		}

		lines.push('---');
		lines.push(`_${localize('sync.footer', "This update was generated from VS Code agent sessions.")}_`);
		return lines.join('\n');
	}

	// #endregion
}

// #region Internal types

interface IConversationExchange {
	readonly userMessage: string;
	readonly agentResponse: string;
}

interface IFileChangeInfo {
	readonly fileName: string;
	readonly insertions: number;
	readonly deletions: number;
}

interface ISessionData {
	readonly title: string;
	readonly status: SessionStatus;
	readonly updatedAt: Date;
	readonly exchanges: IConversationExchange[];
	readonly fileChanges: IFileChangeInfo[];
}

interface ISessionInsight {
	readonly sessionTitle: string;
	readonly status: string;
	readonly raw: string;
	readonly fileChanges: IFileChangeInfo[];
}

// #endregion

// #region Formatting helpers

function formatSessionStatus(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.Untitled: return 'Not Started';
		case SessionStatus.InProgress: return 'In Progress';
		case SessionStatus.NeedsInput: return 'Needs Input';
		case SessionStatus.Completed: return 'Completed';
		case SessionStatus.Error: return 'Error';
	}
}

// #endregion
