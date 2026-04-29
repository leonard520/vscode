/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { basename } from '../../../../base/common/resources.js';
import { localize } from '../../../../nls.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IWorkItem, WorkItemPriority, WorkItemStatus } from '../../../services/workItems/common/workItem.js';
import { ISession, SessionStatus } from '../../../services/sessions/common/session.js';
import { isIChatSessionFileChange2 } from '../../../../workbench/contrib/chat/common/chatSessionsService.js';
import { ChatMessageRole, IChatMessage, ILanguageModelsService, getTextResponseFromStream } from '../../../../workbench/contrib/chat/common/languageModels.js';

/**
 * Supported time range presets for summary generation.
 */
export const enum SummaryTimeRange {
	Today = 'today',
	ThisWeek = 'thisWeek',
	ThisMonth = 'thisMonth',
	Custom = 'custom',
}

/**
 * Input data collected from work items and sessions,
 * ready to be fed into a summary strategy.
 */
export interface ISummaryInput {
	readonly timeRange: SummaryTimeRange;
	readonly from: Date;
	readonly to: Date;
	readonly workItems: readonly IWorkItemSnapshot[];
}

/**
 * A point-in-time snapshot of a work item with its associated sessions,
 * used as input for summary generation.
 */
export interface IWorkItemSnapshot {
	readonly id: string;
	readonly title: string;
	readonly status: WorkItemStatus;
	readonly priority: WorkItemPriority;
	readonly labels: readonly string[];
	readonly sessions: readonly ISessionSnapshot[];
}

/**
 * A point-in-time snapshot of a session.
 */
export interface ISessionSnapshot {
	readonly sessionId: string;
	readonly title: string;
	readonly status: SessionStatus;
	readonly createdAt: Date;
	readonly updatedAt: Date;
	readonly fileChanges: readonly IFileChangeSummary[];
}

/**
 * Summarized file change info from a session.
 */
export interface IFileChangeSummary {
	readonly fileName: string;
	readonly insertions: number;
	readonly deletions: number;
}

/**
 * The result produced by a summary strategy.
 */
export interface ISummaryResult {
	readonly markdown: string;
}

/**
 * Strategy interface for generating summaries.
 * Implement this to plug in different generation algorithms
 * (local template, LLM-based, etc.).
 */
export interface ISummaryStrategy {
	readonly id: string;
	readonly label: string;
	generate(input: ISummaryInput, token: CancellationToken): Promise<ISummaryResult>;
}

// #region Data collection helpers

/**
 * Compute the date range for a given time range preset.
 */
export function computeDateRange(range: SummaryTimeRange, customFrom?: Date, customTo?: Date): { from: Date; to: Date } {
	const now = new Date();
	const to = customTo ?? now;

	switch (range) {
		case SummaryTimeRange.Today: {
			const from = new Date(now);
			from.setHours(0, 0, 0, 0);
			return { from, to };
		}
		case SummaryTimeRange.ThisWeek: {
			const from = new Date(now);
			from.setDate(from.getDate() - from.getDay());
			from.setHours(0, 0, 0, 0);
			return { from, to };
		}
		case SummaryTimeRange.ThisMonth: {
			const from = new Date(now.getFullYear(), now.getMonth(), 1);
			return { from, to };
		}
		case SummaryTimeRange.Custom: {
			return { from: customFrom ?? now, to };
		}
	}
}

/**
 * Collect a summary input from work items, filtering by date range.
 */
export function collectSummaryInput(
	workItems: readonly IWorkItem[],
	timeRange: SummaryTimeRange,
	from: Date,
	to: Date,
): ISummaryInput {
	const snapshots: IWorkItemSnapshot[] = [];

	for (const item of workItems) {
		const sessions = item.sessions.get();
		const relevantSessions = sessions.filter(s => {
			const updated = s.updatedAt.get();
			return updated >= from && updated <= to;
		});

		if (relevantSessions.length === 0) {
			// Still include item if it was updated in range
			const itemUpdated = item.updatedAt.get();
			if (itemUpdated < from || itemUpdated > to) {
				continue;
			}
		}

		snapshots.push({
			id: item.id,
			title: item.title.get(),
			status: item.status.get(),
			priority: item.priority.get(),
			labels: [...item.labels.get()],
			sessions: relevantSessions.map(s => snapshotSession(s)),
		});
	}

	return { timeRange, from, to, workItems: snapshots };
}

function snapshotSession(session: ISession): ISessionSnapshot {
	const changes = session.changes.get();
	const fileChanges: IFileChangeSummary[] = changes.map(c => {
		const uri = isIChatSessionFileChange2(c) ? (c.modifiedUri ?? c.uri) : c.modifiedUri;
		return {
			fileName: basename(uri),
			insertions: c.insertions,
			deletions: c.deletions,
		};
	});

	return {
		sessionId: session.sessionId,
		title: session.title.get(),
		status: session.status.get(),
		createdAt: session.createdAt,
		updatedAt: session.updatedAt.get(),
		fileChanges,
	};
}

// #endregion

// #region Built-in strategies

/**
 * A simple template-based summary strategy that produces markdown
 * without requiring LLM access. Good as a fallback or for quick overviews.
 */
export class TemplateSummaryStrategy implements ISummaryStrategy {
	readonly id = 'template';
	readonly label = localize('summaryStrategy.template', "Quick Summary");

	async generate(input: ISummaryInput, _token: CancellationToken): Promise<ISummaryResult> {
		const lines: string[] = [];

		const rangeLabel = formatTimeRangeLabel(input.timeRange, input.from, input.to);
		lines.push(`# ${localize('summary.title', "Work Summary")} — ${rangeLabel}`);
		lines.push('');
		lines.push(localize(
			'summary.overview',
			"{0} work items with activity in this period.",
			input.workItems.length,
		));
		lines.push('');

		if (input.workItems.length === 0) {
			lines.push(localize('summary.noActivity', "No work item activity found in this time range."));
			return { markdown: lines.join('\n') };
		}

		for (const item of input.workItems) {
			const statusIcon = item.status === WorkItemStatus.Open ? '🟢' : '🟣';
			lines.push(`## ${statusIcon} ${item.title}`);
			lines.push('');

			if (item.labels.length > 0) {
				lines.push(`**${localize('summary.labels', "Labels")}:** ${item.labels.join(', ')}`);
				lines.push('');
			}

			if (item.sessions.length === 0) {
				lines.push(localize('summary.noSessions', "No sessions in this period."));
			} else {
				lines.push(`**${localize('summary.sessions', "Sessions")}:** ${item.sessions.length}`);
				lines.push('');

				for (const session of item.sessions) {
					const statusLabel = formatSessionStatus(session.status);
					lines.push(`### ${session.title || localize('summary.untitledSession', "Untitled Session")}`);
					lines.push(`- **${localize('summary.status', "Status")}:** ${statusLabel}`);

					if (session.fileChanges.length > 0) {
						const totalInsertions = session.fileChanges.reduce((sum, c) => sum + c.insertions, 0);
						const totalDeletions = session.fileChanges.reduce((sum, c) => sum + c.deletions, 0);
						lines.push(`- **${localize('summary.changes', "Changes")}:** ${session.fileChanges.length} files (+${totalInsertions} -${totalDeletions})`);

						for (const change of session.fileChanges) {
							lines.push(`  - \`${change.fileName}\` (+${change.insertions} -${change.deletions})`);
						}
					}
					lines.push('');
				}
			}
		}

		return { markdown: lines.join('\n') };
	}
}

/**
 * The level of detail for LLM-generated time-range summaries.
 */
export const enum SummaryMode {
	/** Brief, objective overview: what was worked on, progress status, key metrics. */
	Simple = 'simple',
	/** Detailed analysis: background, decisions, trade-offs, implementation details — grouped by theme. */
	Detailed = 'detailed',
}

/**
 * LLM-based summary strategy that synthesizes work items intelligently.
 * Groups related work items, merges overlapping themes, and produces
 * coherent narratives rather than per-item lists.
 */
export class LLMSummaryStrategy implements ISummaryStrategy {
	readonly id = 'llm';
	readonly label = localize('summaryStrategy.llm', "AI Summary");

	constructor(
		private readonly _mode: SummaryMode,
		private readonly _languageModelsService: ILanguageModelsService,
		private readonly _logService: ILogService,
	) { }

	async generate(input: ISummaryInput, token: CancellationToken): Promise<ISummaryResult> {
		const modelId = await this._findModel();
		if (!modelId) {
			this._logService.warn('[LLMSummaryStrategy] No copilot model available, falling back to template');
			const fallback = new TemplateSummaryStrategy();
			return fallback.generate(input, token);
		}

		const rangeLabel = formatTimeRangeLabel(input.timeRange, input.from, input.to);
		const dataBlock = this._buildInputBlock(input);
		const systemPrompt = this._mode === SummaryMode.Simple
			? this._buildSimplePrompt(rangeLabel)
			: this._buildDetailedPrompt(rangeLabel);

		const messages: IChatMessage[] = [
			{ role: ChatMessageRole.System, content: [{ type: 'text', value: systemPrompt }] },
			{ role: ChatMessageRole.User, content: [{ type: 'text', value: dataBlock }] },
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
				this._logService.warn('[LLMSummaryStrategy] LLM returned empty response');
				const fallback = new TemplateSummaryStrategy();
				return fallback.generate(input, token);
			}
			const signature = `\n\n---\n*✨ Synthesized by Agent App · ${rangeLabel} · ${new Date().toLocaleString()}*`;
			return { markdown: text + signature };
		} catch (e) {
			this._logService.warn('[LLMSummaryStrategy] LLM request failed:', e);
			const fallback = new TemplateSummaryStrategy();
			return fallback.generate(input, token);
		}
	}

	private _buildSimplePrompt(rangeLabel: string): string {
		return [
			`You are producing a concise work progress report for the period: ${rangeLabel}.`,
			'',
			'Your job is to give an OBJECTIVE overview of what was worked on and the current status.',
			'',
			'IMPORTANT: If multiple work items are related or overlap in theme (e.g. same feature area, same codebase, same goal), GROUP them together under a single heading. Do NOT list every work item separately if they logically belong together.',
			'',
			'Structure your output as:',
			'',
			'# Work Progress — [period]',
			'',
			'A 1-2 sentence overall summary of the period.',
			'',
			'## [Theme/Area Name]',
			'- Status: [overall status for this group]',
			'- Work items: [list the item titles that belong here]',
			'- Progress: [1-2 sentences on what was accomplished]',
			'- Sessions: N completed, M in progress',
			'- Files changed: N files (+X -Y)',
			'',
			'(Repeat for each theme/group)',
			'',
			'## Summary Statistics',
			'- Total work items: N',
			'- Total sessions: N (completed: X, in progress: Y, error: Z)',
			'- Total file changes: N files',
			'',
			'Rules:',
			'- Be objective and factual. Report what happened, not opinions.',
			'- Group related work items by theme/area. This is critical.',
			'- Use bullet points. Keep it scannable.',
			'- Include session counts and file change metrics.',
			'- Target 150-400 words total.',
		].join('\n');
	}

	private _buildDetailedPrompt(rangeLabel: string): string {
		return [
			`You are producing a detailed work analysis report for the period: ${rangeLabel}.`,
			'',
			'Your job is to synthesize all work items into a coherent technical narrative.',
			'',
			'IMPORTANT: If multiple work items are related or overlap in theme (e.g. same feature area, same bug cluster, same refactoring effort), MERGE them into a single section. Do NOT repeat information. Group by logical theme, not by individual work item.',
			'',
			'Structure your output as:',
			'',
			'# Work Analysis — [period]',
			'',
			'## Executive Summary',
			'A paragraph summarizing the overall work direction, key accomplishments, and current state.',
			'',
			'## [Theme/Area 1]',
			'',
			'### Background',
			'Why this work exists. What motivated it.',
			'',
			'### What Was Done',
			'- Specific implementation details',
			'- Files and components changed',
			'- Technical approaches taken',
			'',
			'### Decisions & Trade-offs',
			'Key decisions made and why. Trade-offs considered.',
			'',
			'### Status',
			'Current progress, remaining work, blockers.',
			'',
			'(Repeat for each theme/group)',
			'',
			'## Open Items & Follow-ups',
			'- TODO: items that need to be done next',
			'- RISK: potential issues or concerns',
			'- QUESTION: unresolved decisions',
			'',
			'Rules:',
			'- MERGE related work items. This is the most important rule.',
			'- Be specific: include file names, function names, technical details.',
			'- Show the progression of work — how things evolved across sessions.',
			'- Use bullet points for readability.',
			'- When work items contribute to the same goal, present them as one coherent story.',
			'- Target 500-1500 words depending on the volume of work.',
		].join('\n');
	}

	private _buildInputBlock(input: ISummaryInput): string {
		const lines: string[] = [];
		lines.push(`Period: ${input.from.toLocaleDateString()} to ${input.to.toLocaleDateString()}`);
		lines.push(`Total work items with activity: ${input.workItems.length}`);
		lines.push('');

		for (const item of input.workItems) {
			const statusLabel = item.status === WorkItemStatus.Open ? 'Open' : 'Completed';
			lines.push(`## Work Item: "${item.title}" [${statusLabel}]`);
			if (item.labels.length > 0) {
				lines.push(`Labels: ${item.labels.join(', ')}`);
			}
			lines.push(`Sessions: ${item.sessions.length}`);
			lines.push('');

			for (const session of item.sessions) {
				const sessionStatus = formatSessionStatus(session.status);
				lines.push(`### Session: "${session.title}" [${sessionStatus}]`);
				lines.push(`Updated: ${session.updatedAt.toLocaleString()}`);
				if (session.fileChanges.length > 0) {
					const totalIns = session.fileChanges.reduce((s, c) => s + c.insertions, 0);
					const totalDel = session.fileChanges.reduce((s, c) => s + c.deletions, 0);
					lines.push(`Files changed: ${session.fileChanges.length} (+${totalIns} -${totalDel})`);
					for (const change of session.fileChanges) {
						lines.push(`  - ${change.fileName} (+${change.insertions} -${change.deletions})`);
					}
				}
				lines.push('');
			}
			lines.push('---');
		}

		return lines.join('\n');
	}

	private async _findModel(): Promise<string | undefined> {
		const copilotModels = await this._languageModelsService.selectLanguageModels({ vendor: 'copilot' });
		let bestId: string | undefined;
		let bestMaxInput = 0;

		for (const id of copilotModels) {
			const metadata = this._languageModelsService.lookupLanguageModel(id);
			if (metadata && metadata.isUserSelectable !== false) {
				if (metadata.maxInputTokens > bestMaxInput) {
					bestMaxInput = metadata.maxInputTokens;
					bestId = id;
				}
			}
		}

		return bestId ?? copilotModels[0];
	}
}

// #endregion

// #region Formatting helpers

function formatTimeRangeLabel(range: SummaryTimeRange, from: Date, to: Date): string {
	switch (range) {
		case SummaryTimeRange.Today:
			return localize('summary.range.today', "Today");
		case SummaryTimeRange.ThisWeek:
			return localize('summary.range.thisWeek', "This Week");
		case SummaryTimeRange.ThisMonth:
			return localize('summary.range.thisMonth', "This Month");
		case SummaryTimeRange.Custom:
			return `${from.toLocaleDateString()} – ${to.toLocaleDateString()}`;
	}
}

function formatSessionStatus(status: SessionStatus): string {
	switch (status) {
		case SessionStatus.Untitled: return localize('summary.session.untitled', "Not Started");
		case SessionStatus.InProgress: return localize('summary.session.inProgress', "In Progress");
		case SessionStatus.NeedsInput: return localize('summary.session.needsInput', "Needs Input");
		case SessionStatus.Completed: return localize('summary.session.completed', "Completed");
		case SessionStatus.Error: return localize('summary.session.error', "Error");
	}
}

// #endregion

// #region Per-work-item session summary

/**
 * Generate a natural language markdown summary of a single work item's sessions.
 * Intended for syncing progress to a linked GitHub issue as a comment.
 */
export function generateWorkItemSessionSummary(workItem: IWorkItem): string {
	const sessions = workItem.sessions.get();
	const lines: string[] = [];

	lines.push(`## ${localize('sync.progressUpdate', "Progress Update")}`);
	lines.push('');

	if (sessions.length === 0) {
		lines.push(localize('sync.noSessions', "No agent sessions associated with this work item yet."));
		return lines.join('\n');
	}

	const completedSessions = sessions.filter(s => s.status.get() === SessionStatus.Completed);
	const inProgressSessions = sessions.filter(s => s.status.get() === SessionStatus.InProgress);
	const errorSessions = sessions.filter(s => s.status.get() === SessionStatus.Error);

	// Overview line
	const parts: string[] = [];
	if (completedSessions.length > 0) {
		parts.push(localize('sync.completedCount', "{0} completed", completedSessions.length));
	}
	if (inProgressSessions.length > 0) {
		parts.push(localize('sync.inProgressCount', "{0} in progress", inProgressSessions.length));
	}
	if (errorSessions.length > 0) {
		parts.push(localize('sync.errorCount', "{0} errored", errorSessions.length));
	}
	const otherCount = sessions.length - completedSessions.length - inProgressSessions.length - errorSessions.length;
	if (otherCount > 0) {
		parts.push(localize('sync.otherCount', "{0} other", otherCount));
	}
	lines.push(localize('sync.overview', "{0} agent sessions ({1}).", sessions.length, parts.join(', ')));
	lines.push('');

	// Per-session detail
	for (const session of sessions) {
		const snapshot = snapshotSession(session);
		const statusLabel = formatSessionStatus(snapshot.status);
		const title = snapshot.title || localize('sync.untitledSession', "Untitled Session");

		lines.push(`### ${title}`);
		lines.push(`**${localize('sync.statusLabel', "Status")}:** ${statusLabel}  `);
		lines.push(`**${localize('sync.updatedAt', "Last Updated")}:** ${snapshot.updatedAt.toLocaleString()}`);

		if (snapshot.fileChanges.length > 0) {
			const totalInsertions = snapshot.fileChanges.reduce((sum, c) => sum + c.insertions, 0);
			const totalDeletions = snapshot.fileChanges.reduce((sum, c) => sum + c.deletions, 0);
			lines.push('');
			lines.push(localize(
				'sync.filesSummary',
				"Changed {0} files (+{1} -{2}):",
				snapshot.fileChanges.length,
				totalInsertions,
				totalDeletions,
			));
			for (const change of snapshot.fileChanges) {
				lines.push(`- \`${change.fileName}\` (+${change.insertions} -${change.deletions})`);
			}
		}
		lines.push('');
	}

	lines.push('---');
	lines.push(`_${localize('sync.footer', "This update was generated from VS Code agent sessions.")}_`);

	return lines.join('\n');
}

// #endregion
